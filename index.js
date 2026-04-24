const express = require("express");
const line = require("@line/bot-sdk");
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const config = {
  channelSecret: process.env.CHANNEL_SECRET,
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
};

const client = new line.Client(config);
const app = express();

const userState = {};

const stages = [
  "告知・検査中",
  "手術前の準備中",
  "手術・入院中",
  "治療中",
  "効果の確認中",
  "経過観察中",
  "わからない・未確認",
];

// 告知時期の選択肢 → 基準日を計算するためのオフセット（日数）
const DIAGNOSIS_CHOICES = [
  { label: "1週間以内",  offsetDays: 3   },
  { label: "約1ヶ月前",  offsetDays: 30  },
  { label: "約3ヶ月前",  offsetDays: 90  },
  { label: "約半年前",   offsetDays: 180 },
  { label: "1年以上前",  offsetDays: 400 },
];

function calcDiagnosisDate(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() - offsetDays);
  return d.toISOString().split("T")[0]; // YYYY-MM-DD
}

const questions = {
  "告知・検査中": [
    { text: "職場への報告はもうされましたか？", choices: ["はい", "まだ"] },
    { text: "民間保険の証券は確認できましたか？", choices: ["はい", "まだ"] },
    { text: "住宅ローンはありますか？", choices: ["ある", "ない"] },
  ],
  手術前の準備中: [
    { text: "入院の準備は整っていますか？", choices: ["はい", "まだ"] },
    { text: "手術の説明は医師から受けましたか？", choices: ["はい", "まだ"] },
    { text: "家族への連絡は済んでいますか？", choices: ["はい", "まだ"] },
  ],
  "手術・入院中": [
    { text: "担当医との術前面談はされましたか？", choices: ["はい", "まだ"] },
    { text: "入院中の費用の確認はできていますか？", choices: ["はい", "まだ"] },
    { text: "術後のリハビリ計画は確認しましたか？", choices: ["はい", "まだ"] },
  ],
  治療中: [
    { text: "副作用の対処法は確認していますか？", choices: ["はい", "まだ"] },
    {
      text: "栄養管理について医師や栄養士に相談しましたか？",
      choices: ["はい", "まだ"],
    },
    {
      text: "治療中の就労や休職について職場と話しましたか？",
      choices: ["はい", "まだ"],
    },
  ],
  効果の確認中: [
    { text: "次回の検査日は決まっていますか？", choices: ["はい", "まだ"] },
    {
      text: "治療の効果について医師から説明を受けましたか？",
      choices: ["はい", "まだ"],
    },
    {
      text: "主治医に気になることを質問できていますか？",
      choices: ["はい", "まだ"],
    },
  ],
  経過観察中: [
    {
      text: "定期検診のスケジュールは把握していますか？",
      choices: ["はい", "まだ"],
    },
    { text: "生活習慣の見直しは始めていますか？", choices: ["はい", "まだ"] },
    {
      text: "職場や家庭での生活は落ち着いてきましたか？",
      choices: ["はい", "まだ"],
    },
  ],
  "わからない・未確認": [
    {
      text: "医師から何らかの診断や説明は受けましたか？",
      choices: ["はい", "まだ"],
    },
    {
      text: "信頼できる身近な人に状況を話せていますか？",
      choices: ["はい", "まだ"],
    },
    {
      text: "今、一番不安に感じていることはお金のことですか？",
      choices: ["はい", "いいえ"],
    },
  ],
};

app.post("/webhook", line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then(() => res.json({ status: "ok" }))
    .catch((err) => res.status(500).end());
});

// ── 診断時期を質問する ────────────────────────────
async function askDiagnosisDate(replyToken) {
  return client.replyMessage(replyToken, {
    type: "text",
    text: "告知はいつ頃でしたか？",
    quickReply: {
      items: DIAGNOSIS_CHOICES.map((c) => ({
        type: "action",
        action: {
          type: "message",
          label: c.label,
          text: c.label,
        },
      })),
    },
  });
}

// ── Q&A を順番に送る ─────────────────────────────
async function sendNextQuestion(replyToken, userId) {
  const state = userState[userId];
  const stageQuestions = questions[state.stage];
  const currentIndex = state.questionIndex;

  if (currentIndex < stageQuestions.length) {
    const q = stageQuestions[currentIndex];
    return client.replyMessage(replyToken, {
      type: "text",
      text: q.text,
      quickReply: {
        items: q.choices.map((choice) => ({
          type: "action",
          action: {
            type: "message",
            label: choice,
            text: choice,
          },
        })),
      },
    });
  }

  // ── 全問完了 → Supabase に保存 ──────────────────
  const { error } = await supabase
    .from("onboardings")
    .upsert(
      {
        user_id:         userId,
        stage:           state.stage,
        diagnosis_date:  state.diagnosis_date,
        answers:         state.answers,
        alert_scheduled: false,
      },
      { onConflict: "user_id" }
    );
  if (error) {
    console.error("[onboarding] Supabase保存エラー:", error.message);
  }

  delete userState[userId];
  return client.replyMessage(replyToken, {
    type: "text",
    text: "わかりました。明日朝7:00から、まだ終わっていないことから順番にお届けします。",
  });
}

async function handleEvent(event) {
  if (event.type === "follow") {
    const userId = event.source.userId;
    return client.pushMessage(userId, {
      type: "text",
      text: "さいごに1つだけ教えてください。\n今、どの状況ですか？\n\n選んでいただいた状況に合わせたメッセージを明日からお送りします。",
      quickReply: {
        items: stages.map((stage) => ({
          type: "action",
          action: {
            type: "message",
            label: stage,
            text: stage,
          },
        })),
      },
    });
  }

  if (event.type !== "message" || event.message.type !== "text") return;

  const userId = event.source.userId;
  const userText = event.message.text;

  // ── ステージ選択 → 診断時期を質問 ────────────────
  if (stages.includes(userText)) {
    userState[userId] = {
      stage:          userText,
      phase:          "diagnosis_date", // 次は診断時期を受け取る
      questionIndex:  0,
      answers:        {},
      diagnosis_date: null,
    };
    return askDiagnosisDate(event.replyToken, userId);
  }

  if (userState[userId]) {
    const state = userState[userId];

    // ── 診断時期の回答を受け取る ──────────────────
    if (state.phase === "diagnosis_date") {
      const choice = DIAGNOSIS_CHOICES.find((c) => c.label === userText);
      if (choice) {
        state.diagnosis_date = calcDiagnosisDate(choice.offsetDays);
        state.phase = "questions";
        return sendNextQuestion(event.replyToken, userId);
      }
      // 選択肢以外が来た場合は再質問
      return askDiagnosisDate(event.replyToken, userId);
    }

    // ── Q&A の回答を受け取る ──────────────────────
    if (state.phase === "questions") {
      const stageQuestions = questions[state.stage];
      const currentQuestion = stageQuestions[state.questionIndex];
      state.answers[currentQuestion.text] = userText;
      state.questionIndex += 1;
      return sendNextQuestion(event.replyToken, userId);
    }
  }

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: "現在の状況を教えてください。",
    quickReply: {
      items: stages.map((stage) => ({
        type: "action",
        action: {
          type: "message",
          label: stage,
          text: stage,
        },
      })),
    },
  });
}

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Bot running on port ${port}`));
