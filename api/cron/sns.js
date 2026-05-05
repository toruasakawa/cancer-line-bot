'use strict';

require('dotenv').config({ override: true });

const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

// ── テーマリスト ──────────────────────────────────
const THEMES = [
  'がん患者の家族が知っておきたい医療費控除の申請方法',
  '主治医への上手な質問の仕方',
  '病院内のソーシャルワーカー活用術',
  'がん治療中の仕事と介護の両立ポイント',
  '抗がん剤治療中の食事・栄養の工夫',
  'がん患者家族のメンタルケアと相談窓口',
  '治療費の公的補助・高額療養費制度を活用する方法',
];

// ── Claude API でツイートコピー生成 ─────────────
async function generateTweetCopy(theme) {
  const client = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
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

// ── X API OAuth 1.0a ─────────────────────────────
function buildOAuthHeader(method, url, params = {}) {
  const oauthParams = {
    oauth_consumer_key:     process.env.X_API_KEY,
    oauth_nonce:            crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp:        Math.floor(Date.now() / 1000).toString(),
    oauth_token:            process.env.X_ACCESS_TOKEN,
    oauth_version:          '1.0',
  };
  const allParams = { ...oauthParams, ...params };
  const paramStr = Object.keys(allParams).sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(allParams[k])}`).join('&');
  const baseStr = [method.toUpperCase(), encodeURIComponent(url), encodeURIComponent(paramStr)].join('&');
  const signingKey = `${encodeURIComponent(process.env.X_API_SECRET)}&${encodeURIComponent(process.env.X_ACCESS_TOKEN_SECRET)}`;
  oauthParams.oauth_signature = crypto.createHmac('sha1', signingKey).update(baseStr).digest('base64');
  const headerStr = Object.entries(oauthParams)
    .map(([k, v]) => `${encodeURIComponent(k)}="${encodeURIComponent(v)}"`).join(', ');
  return `OAuth ${headerStr}`;
}

async function postTweet(text) {
  const url = 'https://api.twitter.com/2/tweets';
  const res = await axios.post(url, { text }, {
    headers: {
      Authorization: buildOAuthHeader('POST', url),
      'Content-Type': 'application/json',
    },
  });
  return res.data;
}

// ── Vercel Serverless Handler ────────────────────
module.exports = async function handler(req, res) {
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // どのスロット(UTC時間)で呼ばれたか判定
  // 14:00 UTC = 23:00 JST, 15:00 UTC = 00:00 JST, 16:00 UTC = 01:00 JST
  const utcHour = new Date().getUTCHours();
  const slotIndex = utcHour === 14 ? 0 : utcHour === 15 ? 1 : 2;
  const theme = THEMES[slotIndex % THEMES.length];

  let tweetText;
  try {
    tweetText = await generateTweetCopy(theme);
  } catch (e) {
    return res.status(500).json({ error: 'Claude API失敗: ' + e.message });
  }

  try {
    const result = await postTweet(tweetText);
    const tweetId = result.data?.id;

    // Supabase に投稿ログを記録
    try {
      const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
      await supabase.from('sns_post_log').insert({
        tweet_id:   tweetId,
        theme,
        body:       tweetText,
        posted_at:  new Date().toISOString(),
        slot_utc:   utcHour,
      });
    } catch (dbErr) {
      // ログ失敗は無視してツイート成功を返す
      console.warn('[sns] DB記録スキップ:', dbErr.message);
    }

    return res.status(200).json({ message: '投稿完了', tweet_id: tweetId, theme, body: tweetText });
  } catch (e) {
    return res.status(500).json({ error: 'X API失敗: ' + e.message });
  }
};
