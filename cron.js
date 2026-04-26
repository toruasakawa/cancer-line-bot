'use strict';

const line = require("@line/bot-sdk");
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const lineClient = new line.Client({
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
});

// 引数で free / paid を切り替え
// node cron.js free  → 7:00 JST 配信（全ユーザー）
// node cron.js paid  → 7:30 JST 配信（有料ユーザーのみ）
const planType = process.argv[2] || "free";

async function run() {
  console.log(`[cron] 実行開始: plan_type=${planType}`);

  // 今日の日付（JST）を取得
  const now = new Date();
  const jstOffset = 9 * 60 * 60 * 1000;
  const jstNow = new Date(now.getTime() + jstOffset);
  const today = jstNow.toISOString().split("T")[0]; // YYYY-MM-DD

  console.log(`[cron] 配信対象日: ${today}`);

  // delivery_queue から今日・未送信・対象plan_typeの行を取得
  const { data: rows, error: fetchErr } = await supabase
    .from("delivery_queue")
    .select("*")
    .eq("scheduled_date", today)
    .eq("sent", false)
    .eq("plan_type", planType);

  if (fetchErr) {
    console.error("[cron] 取得エラー:", fetchErr.message);
    process.exit(1);
  }

  console.log(`[cron] 配信件数: ${rows.length}件`);

  if (rows.length === 0) {
    console.log("[cron] 配信対象なし。終了。");
    return;
  }

  let successCount = 0;
  let failCount = 0;

  for (const row of rows) {
    try {
      // LINE pushMessage で送信
      await lineClient.pushMessage(row.line_id, {
        type: "text",
        text: row.content,
      });

      // 送信済みフラグを更新
      const { error: updateErr } = await supabase
        .from("delivery_queue")
        .update({ sent: true })
        .eq("id", row.id);

      if (updateErr) {
        console.error(`[cron] sent更新エラー id=${row.id}:`, updateErr.message);
      } else {
        successCount++;
        console.log(`[cron] 送信済み: line_id=${row.line_id} type=${row.message_type}`);
      }
    } catch (e) {
      failCount++;
      console.error(`[cron] 送信失敗: line_id=${row.line_id}`, e.message);
    }
  }

  console.log(`[cron] 完了: 成功=${successCount}件 失敗=${failCount}件`);
}

run().catch((e) => {
  console.error("[cron] 致命的エラー:", e);
  process.exit(1);
});
