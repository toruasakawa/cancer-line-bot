'use strict';

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const crypto = require('crypto');

const DRY_RUN = process.env.RUN_MODE !== 'production';

// ── スケジュール定義 ─────────────────────────
// 深夜3枠: 23:00 / 0:00 / 1:00 (JST)
const SLOTS = ['23:00', '00:00', '01:00'];

// ── Claude APIでツイートコピー生成 ─────────────
async function generateTweetCopy(theme) {
  const client = new Anthropic.default();
  const msg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 300,
    messages: [
      {
        role: 'user',
        content: `難病ナビの公式Xアカウントとして、以下のテーマで140文字以内のツイートを1件生成してください。
語尾は断定的にせず、寄り添うトーンで。ハッシュタグは2〜3個。

テーマ: ${theme}

ツイート本文のみ出力してください。`,
      },
    ],
  });
  return msg.content[0].text.trim();
}

// ── X API v2 ツイート投稿 ──────────────────────
function buildOAuthHeader(method, url, params) {
  const oauthParams = {
    oauth_consumer_key: process.env.X_API_KEY,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: process.env.X_ACCESS_TOKEN,
    oauth_version: '1.0',
  };

  const allParams = { ...oauthParams, ...params };
  const paramStr = Object.keys(allParams)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(allParams[k])}`)
    .join('&');

  const baseStr = [method.toUpperCase(), encodeURIComponent(url), encodeURIComponent(paramStr)].join('&');
  const signingKey = `${encodeURIComponent(process.env.X_API_SECRET)}&${encodeURIComponent(process.env.X_ACCESS_TOKEN_SECRET)}`;
  const signature = crypto.createHmac('sha1', signingKey).update(baseStr).digest('base64');

  oauthParams.oauth_signature = signature;
  const headerStr = Object.entries(oauthParams)
    .map(([k, v]) => `${encodeURIComponent(k)}="${encodeURIComponent(v)}"`)
    .join(', ');

  return `OAuth ${headerStr}`;
}

async function postTweet(text) {
  const url = 'https://api.twitter.com/2/tweets';
  const header = buildOAuthHeader('POST', url, {});
  const res = await axios.post(url, { text }, {
    headers: {
      Authorization: header,
      'Content-Type': 'application/json',
    },
  });
  return res.data;
}

// ── メイン ────────────────────────────────────
async function run() {
  console.log(`[sns] 実行モード: ${DRY_RUN ? 'dry-run' : 'production'}`);

  // テーマリスト（実運用時はSupabaseや外部ファイルから取得）
  const themes = [
    'がん患者の家族が知っておきたい医療費控除の申請方法',
    '主治医への上手な質問の仕方',
    '病院内のソーシャルワーカー活用術',
  ];

  for (let i = 0; i < SLOTS.length; i++) {
    const theme = themes[i % themes.length];
    const slot = SLOTS[i];

    console.log(`[sns] スロット ${slot} / テーマ: ${theme}`);

    const copy = await generateTweetCopy(theme);
    console.log(`[sns] 生成コピー:\n${copy}\n`);

    if (DRY_RUN) {
      console.log(`[sns] dry-run: スロット ${slot} の投稿をスキップ`);
      continue;
    }

    const result = await postTweet(copy);
    console.log(`[sns] 投稿完了: tweet_id=${result.data.id}`);
  }
}

run().catch((e) => {
  console.error('[sns] 致命的エラー:', e);
  process.exit(1);
});
