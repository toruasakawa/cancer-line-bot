'use strict';

require('dotenv').config({ override: true });

const { createClient } = require('@supabase/supabase-js');

const ALERT_RULES = [
  { type: 'day3_followup',   offset_days: 3,  label: '診断3日後フォロー' },
  { type: 'week1_checkin',   offset_days: 7,  label: '1週間チェックイン' },
  { type: 'treatment_start', offset_days: 14, label: '治療開始2週間後' },
  { type: 'month1_checkin',  offset_days: 30, label: '1ヶ月チェックイン' },
  { type: 'month3_review',   offset_days: 90, label: '3ヶ月レビュー' },
];

function calcScheduledAt(baseDate, offsetDays) {
  const d = new Date(baseDate);
  d.setDate(d.getDate() + offsetDays);
  d.setHours(10, 0, 0, 0);
  return d.toISOString();
}

function buildAlertSchedules(onboarding) {
  const baseDate = onboarding.diagnosis_date || onboarding.created_at;
  if (!baseDate) return [];
  return ALERT_RULES.map((rule) => ({
    user_id:      onboarding.user_id,
    alert_type:   rule.type,
    label:        rule.label,
    scheduled_at: calcScheduledAt(baseDate, rule.offset_days),
    status:       'pending',
    created_at:   new Date().toISOString(),
  }));
}

// ── Vercel Serverless Handler ────────────────────
module.exports = async function handler(req, res) {
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { data: onboardings, error: fetchErr } = await supabase
    .from('onboardings')
    .select('user_id, diagnosis_date, created_at')
    .eq('alert_scheduled', false);

  if (fetchErr) return res.status(500).json({ error: fetchErr.message });

  const allSchedules = onboardings.flatMap(buildAlertSchedules);

  if (allSchedules.length === 0) {
    return res.status(200).json({ message: '対象なし', count: 0 });
  }

  const { error: insertErr } = await supabase
    .from('alert_schedule')
    .upsert(allSchedules, { onConflict: 'user_id,alert_type' });
  if (insertErr) return res.status(500).json({ error: insertErr.message });

  const userIds = onboardings.map((o) => o.user_id);
  const { error: updateErr } = await supabase
    .from('onboardings')
    .update({ alert_scheduled: true })
    .in('user_id', userIds);
  if (updateErr) return res.status(500).json({ error: updateErr.message });

  return res.status(200).json({ message: '完了', count: allSchedules.length });
};
