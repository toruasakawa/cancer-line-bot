'use strict';

require('dotenv').config();

const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');
const { createClient } = require('@supabase/supabase-js');

const parser = new XMLParser({ ignoreAttributes: false });

const RSS_SOURCES = [
  {
    name: '厚生労働省 新着情報',
    url: 'https://www.mhlw.go.jp/stf/news.rdf',
    keywords: ['難病', 'がん', '医療費', '指定難病', '患者'],
  },
  {
    name: '厚生労働省 緊急情報',
    url: 'https://www.mhlw.go.jp/stf/kinkyu.rdf',
    keywords: ['難病', 'がん', '医療費', '患者', '給付', '助成'],
  },
];

async function fetchRss(source) {
  const res = await axios.get(source.url, { timeout: 10000 });
  const parsed = parser.parse(res.data);
  const items =
    parsed?.['rdf:RDF']?.item ||
    parsed?.rss?.channel?.item ||
    [];
  return (Array.isArray(items) ? items : [items]).map((item) => ({
    source: source.name,
    title: item.title || '',
    link: item.link || item['@_rdf:about'] || '',
    pub_date: item.pubDate || item['dc:date'] || new Date().toISOString(),
  }));
}

function isRelevant(item, keywords) {
  const text = item.title.toLowerCase();
  return keywords.some((kw) => text.includes(kw.toLowerCase()));
}

async function notifySlack(items) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) return;
  const text = items
    .map((i) => `*[${i.source}]* <${i.link}|${i.title}> (${i.pub_date.slice(0, 10)})`)
    .join('\n');
  await axios.post(webhookUrl, {
    text: `:newspaper: *難病ナビ SEO監視 - 関連記事が更新されました*\n${text}`,
  });
}

// ── Vercel Serverless Handler ────────────────────
module.exports = async function handler(req, res) {
  // Vercel Cron からのリクエストを検証
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // 既知URL取得
    const { data: known } = await supabase.from('seo_seen_urls').select('url');
    const knownSet = new Set((known || []).map((r) => r.url));

    let newItems = [];
    for (const source of RSS_SOURCES) {
      try {
        const items = await fetchRss(source);
        const fresh = items
          .filter((i) => isRelevant(i, source.keywords))
          .filter((i) => !knownSet.has(i.link));
        newItems.push(...fresh);
      } catch (e) {
        console.warn(`[seo] ${source.name} 取得失敗:`, e.message);
      }
    }

    if (newItems.length === 0) {
      return res.status(200).json({ message: '新着なし', count: 0 });
    }

    await notifySlack(newItems);

    const rows = newItems.map((i) => ({ url: i.link, seen_at: new Date().toISOString() }));
    const { error } = await supabase.from('seo_seen_urls').upsert(rows, { onConflict: 'url' });
    if (error) throw error;

    return res.status(200).json({ message: '完了', count: newItems.length });
  } catch (e) {
    console.error('[seo] エラー:', e);
    return res.status(500).json({ error: e.message });
  }
};
