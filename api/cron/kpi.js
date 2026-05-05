'use strict';

require('dotenv').config({ override: true });

const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ── X API OAuth 1.0a ─────────────────────────────
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
  const paramStr = Object.keys(allParams).sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(allParams[k])}`).join('&');
  const baseStr = [method.toUpperCase(), encodeURIComponent(url), encodeURIComponent(paramStr)].join('&');
  const signingKey = `${encodeURIComponent(process.env.X_API_SECRET)}&${encodeURIComponent(process.env.X_ACCESS_TOKEN_SECRET)}`;
  oauthParams.oauth_signature = crypto.createHmac('sha1', signingKey).update(baseStr).digest('base64');
  const headerStr = Object.entries(oauthParams)
    .map(([k, v]) => `${encodeURIComponent(k)}="${encodeURIComponent(v)}"`).join(', ');
  return `OAuth ${headerStr}`;
}

async function fetchXStats() {
  const url = 'https://api.twitter.com/2/users/me';
  const query = { 'user.fields': 'public_metrics' };
  const res = await axios.get(url, { params: query, headers: { Authorization: buildOAuthHeader('GET', url, query) } });
  const m = res.data.data.public_metrics;
  return { x_followers: m.followers_count, x_following: m.following_count, x_tweet_count: m.tweet_count };
}

async function fetchLineStats() {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const res = await axios.get('https://api.line.me/v2/bot/insight/followers',
    { params: { date }, headers: { Authorization: `Bearer ${token}` } });
  return { line_followers: res.data.followers };
}

async function fetchNoteStats() {
  const res = await axios.get(`https://note.com/api/v2/creators/${process.env.NOTE_USERNAME}`);
  const d = res.data.data;
  return { note_followers: d.followerCount, note_like_count: d.likeCount };
}

// ── Vercel Serverless Handler ────────────────────
module.exports = async function handler(req, res) {
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const now = new Date();
  const yyyymm = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
  const kpi = { month: yyyymm, fetched_at: now.toISOString() };

  try { Object.assign(kpi, await fetchXStats()); } catch (e) { console.warn('[kpi] X スキップ:', e.message); }
  try { Object.assign(kpi, await fetchLineStats()); } catch (e) { console.warn('[kpi] LINE スキップ:', e.message); }
  try { Object.assign(kpi, await fetchNoteStats()); } catch (e) { console.warn('[kpi] note スキップ:', e.message); }

  // CSV出力
  const outputDir = path.join('/tmp');
  const csvPath = path.join(outputDir, `kpi_${yyyymm}.csv`);
  const header = Object.keys(kpi).join(',');
  const row = Object.values(kpi).join(',');
  fs.writeFileSync(csvPath, `${header}\n${row}\n`, 'utf8');

  // Supabase投入
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { error } = await supabase.from('kpi_monthly').upsert(kpi, { onConflict: 'month' });
  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json({ message: '完了', month: yyyymm, kpi });
};
