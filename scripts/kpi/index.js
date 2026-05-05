'use strict';

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DRY_RUN = process.env.RUN_MODE !== 'production';

// ── X API: OAuth 1.0a 署名 ───────────────────────
function buildOAuthHeader(method, url, queryParams = {}) {
  const oauthParams = {
    oauth_consumer_key:     process.env.X_API_KEY,
    oauth_nonce:            crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp:        Math.floor(Date.now() / 1000).toString(),
    oauth_token:            process.env.X_ACCESS_TOKEN,
    oauth_version:          '1.0',
  };

  const allParams = { ...oauthParams, ...queryParams };
  const paramStr = Object.keys(allParams)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(allParams[k])}`)
    .join('&');

  const baseStr = [method.toUpperCase(), encodeURIComponent(url), encodeURIComponent(paramStr)].join('&');
  const signingKey = `${encodeURIComponent(process.env.X_API_SECRET)}&${encodeURIComponent(process.env.X_ACCESS_TOKEN_SECRET)}`;
  oauthParams.oauth_signature = crypto.createHmac('sha1', signingKey).update(baseStr).digest('base64');

  const headerStr = Object.entries(oauthParams)
    .map(([k, v]) => `${encodeURIComponent(k)}="${encodeURIComponent(v)}"`)
    .join(', ');
  return `OAuth ${headerStr}`;
}

async function fetchXStats() {
  const required = ['X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_TOKEN_SECRET'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`X API credentials missing: ${missing.join(', ')}`);

  const url = 'https://api.twitter.com/2/users/me';
  const query = { 'user.fields': 'public_metrics' };
  const header = buildOAuthHeader('GET', url, query);

  const res = await axios.get(url, {
    params: query,
    headers: { Authorization: header },
  });
  const m = res.data.data.public_metrics;
  return {
    x_followers:   m.followers_count,
    x_following:   m.following_count,
    x_tweet_count: m.tweet_count,
  };
}

// ── LINE Messaging API ────────────────────────────
async function fetchLineStats() {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) throw new Error('LINE_CHANNEL_ACCESS_TOKEN missing');

  // 当日の友だち数（日付指定なしで最新を取得）
  const res = await axios.get('https://api.line.me/v2/bot/insight/followers', {
    params: { date: new Date().toISOString().slice(0, 10).replace(/-/g, '') },
    headers: { Authorization: `Bearer ${token}` },
  });
  return { line_followers: res.data.followers };
}

// ── note API ──────────────────────────────────────
async function fetchNoteStats() {
  const username = process.env.NOTE_USERNAME;
  if (!username) throw new Error('NOTE_USERNAME missing');

  // note の creator API は認証不要（公開情報）
  const res = await axios.get(`https://note.com/api/v2/creators/${username}`);
  const d = res.data.data;
  return {
    note_followers: d.followerCount,
    note_like_count: d.likeCount,
  };
}

// ── メイン ────────────────────────────────────────
async function run() {
  const now = new Date();
  const yyyymm = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;

  console.log(`[kpi] 実行モード: ${DRY_RUN ? 'dry-run' : 'production'}`);
  console.log(`[kpi] 対象月: ${yyyymm}`);

  const kpi = { month: yyyymm, fetched_at: now.toISOString() };

  try { Object.assign(kpi, await fetchXStats()); }
  catch (e) { console.warn('[kpi] X API スキップ:', e.message); }

  try { Object.assign(kpi, await fetchLineStats()); }
  catch (e) { console.warn('[kpi] LINE API スキップ:', e.message); }

  try { Object.assign(kpi, await fetchNoteStats()); }
  catch (e) { console.warn('[kpi] note API スキップ:', e.message); }

  console.log('[kpi] 取得結果:', kpi);

  // CSV出力
  const outputDir = path.join(__dirname, '../../outputs');
  fs.mkdirSync(outputDir, { recursive: true });
  const csvPath = path.join(outputDir, `kpi_${yyyymm}.csv`);
  const header = Object.keys(kpi).join(',');
  const row = Object.values(kpi).join(',');
  fs.writeFileSync(csvPath, `${header}\n${row}\n`, 'utf8');
  console.log(`[kpi] CSV出力: ${csvPath}`);

  if (DRY_RUN) {
    console.log('[kpi] dry-run: Supabaseへの書き込みをスキップ');
    return;
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { error } = await supabase.from('kpi_monthly').upsert(kpi, { onConflict: 'month' });
  if (error) throw error;
  console.log('[kpi] Supabase書き込み完了');
}

run().catch((e) => {
  console.error('[kpi] 致命的エラー:', e);
  process.exit(1);
});
