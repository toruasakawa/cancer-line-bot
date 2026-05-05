'use strict';

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const DRY_RUN = process.env.RUN_MODE !== 'production';

// ── アラート種別とオフセット日数 ─────────────────
// オンボーディング回答の基準日からN日後にアラートを送る
const ALERT_RULES = [
  { type: 'day3_followup',      offset_days: 3,   label: '診断3日後フォロー' },
  { type: 'week1_checkin',      offset_days: 7,   label: '1週間チェックイン' },
  { type: 'month1_checkin',     offset_days: 30,  label: '1ヶ月チェックイン' },
  { type: 'treatment_start',    offset_days: 14,  label: '治療開始2週間後' },
  { type: 'month3_review',      offset_days: 90,  label: '3ヶ月レビュー' },
];

function calcScheduledAt(baseDate, offsetDays) {
  const d = new Date(baseDate);
  d.setDate(d.getDate() + offsetDays);
  // 送信は10:00 JST固定
  d.setHours(10, 0, 0, 0);
  return d.toISOString();
}

// ── オンボーディング回答からアラートスケジュールを生成 ──
function buildAlertSchedules(onboarding) {
  const baseDate = onboarding.diagnosis_date || onboarding.created_at;
  if (!baseDate) {
    console.warn(`[alerts] user_id=${onboarding.user_id}: 基準日が取得できないためスキップ`);
    return [];
  }

  return ALERT_RULES.map((rule) => ({
    user_id:      onboarding.user_id,
    alert_type:   rule.type,
    label:        rule.label,
    scheduled_at: calcScheduledAt(baseDate, rule.offset_days),
    status:       'pending',
    created_at:   new Date().toISOString(),
  }));
}

async function run() {
  console.log(`[alerts] 実行モード: ${DRY_RUN ? 'dry-run' : 'production'}`);

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  // 未処理のオンボーディング回答を取得
  const { data: onboardings, error: fetchErr } = await supabase
    .from('onboardings')
    .select('user_id, diagnosis_date, created_at')
    .eq('alert_scheduled', false);

  if (fetchErr) throw fetchErr;
  console.log(`[alerts] 対象オンボーディング: ${onboardings.length}件`);

  const allSchedules = onboardings.flatMap(buildAlertSchedules);
  console.log(`[alerts] 生成アラート数: ${allSchedules.length}件`);

  if (DRY_RUN) {
    console.log('[alerts] dry-run: Supabaseへの書き込みをスキップ');
    console.log(JSON.stringify(allSchedules.slice(0, 3), null, 2), '...');
    return;
  }

  // alert_schedule テーブルに投入（重複はupsertで無視）
  const { error: insertErr } = await supabase
    .from('alert_schedule')
    .upsert(allSchedules, { onConflict: 'user_id,alert_type' });
  if (insertErr) throw insertErr;

  // 処理済みフラグを立てる
  const userIds = onboardings.map((o) => o.user_id);
  const { error: updateErr } = await supabase
    .from('onboardings')
    .update({ alert_scheduled: true })
    .in('user_id', userIds);
  if (updateErr) throw updateErr;

  console.log('[alerts] 完了');
}

run().catch((e) => {
  console.error('[alerts] 致命的エラー:', e);
  process.exit(1);
});
