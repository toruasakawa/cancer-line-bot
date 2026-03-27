const express = require("express");
const line = require("@line/bot-sdk");

const config = {
  channelSecret: process.env.CHANNEL_SECRET,
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
};

const client = new line.Client(config);
const app = express();

app.post("/webhook", line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then(() => res.json({ status: "ok" }))
    .catch((err) => res.status(500).end());
});

const stages = [
  "告知・検査中",
  "手術前の準備中",
  "手術・入院中",
  "治療中",
  "効果の確認中",
  "経過観察中",
];

async function handleEvent(event) {
  // 友だち追加時
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

  // 通常メッセージの処理
  if (event.type !== "message" || event.message.type !== "text") return;

  const userText = event.message.text;

  // 選択肢が選ばれた場合
  if (stages.includes(userText)) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: `「${userText}」を選んでいただきありがとうございます。明日から、状況に合わせた情報をお届けします。`,
    });
  }

  // それ以外のメッセージ
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
