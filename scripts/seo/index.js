'use strict';

require('dotenv').config();
const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');
const { createClient } = require('@supabase/supabase-js');

const DRY_RUN = process.env.RUN_MODE !== 'production';

// ── 監視対象RSSフィード ────────────────────────
// 難病情報センター（nanbyou.or.jp）はRSS廃止のため除外済み（2026/04確認）
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

const parser = new XMLParser({ ignoreAttributes: false });

async function fetchRss(source) {
  const res = await axios.get(source.url, { timeout: 10000 });
  const parsed = parser.parse(res.data);

  // RDF / RSS 2.0 両対応
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
  if (!webhookUrl) {
    console.warn('[seo] SLACK_WEBHOOK_URL未設定: 通知スキップ');
    return;
  }

  const text = items
    .map((i) => `*[${i.source}]* <${i.link}|${i.title}> (${i.pub_date.slice(0, 10)})`)
    .join('\n');

  await axios.post(webhookUrl, {
    text: `:newspaper: *難病ナビ SEO監視 - 関連記事が更新されました*\n${text}`,
  });
}

async function run() {
  console.log(`[seo] 実行モード: ${DRY_RUN ? 'dry-run' : 'production'}`);

  // dry-run時はSupabase接続をスキップ（既知URLなしで全件を新着扱い）
  let supabase = null;
  let knownSet = new Set();

  if (!DRY_RUN) {
    supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
    const { data: known } = await supabase
      .from('seo_seen_urls')
      .select('url');
    knownSet = new Set((known || []).map((r) => r.url));
  }

  let newItems = [];

  for (const source of RSS_SOURCES) {
    console.log(`[seo] フィード取得: ${source.name}`);
    try {
      const items = await fetchRss(source);
      const relevant = items.filter((i) => isRelevant(i, source.keywords));
      const fresh = relevant.filter((i) => !knownSet.has(i.link));
      console.log(`[seo] ${source.name}: 関連${relevant.length}件 / 新着${fresh.length}件`);
      newItems.push(...fresh);
    } catch (e) {
      console.warn(`[seo] ${source.name} 取得失敗:`, e.message);
    }
  }

  if (newItems.length === 0) {
    console.log('[seo] 新着なし。終了。');
    return;
  }

  console.log(`[seo] 通知対象: ${newItems.length}件`);

  if (DRY_RUN) {
    console.log('[seo] dry-run: Slack通知・DB書き込みをスキップ');
    newItems.forEach((i) => console.log(` - ${i.title}`));
    return;
  }

  await notifySlack(newItems);
  console.log('[seo] Slack通知送信完了');

  // 既読URLを記録
  const rows = newItems.map((i) => ({ url: i.link, seen_at: new Date().toISOString() }));
  const { error } = await supabase.from('seo_seen_urls').upsert(rows, { onConflict: 'url' });
  if (error) throw error;
  console.log('[seo] DB記録完了');
}

run().catch((e) => {
  console.error('[seo] 致命的エラー:', e);
  process.exit(1);
});
