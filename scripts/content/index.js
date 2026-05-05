'use strict';

// RUN_MODE はコマンドライン引数を優先し、APIキーは .env を優先する
const _runMode = process.env.RUN_MODE;
require('dotenv').config({ override: true });
if (_runMode) process.env.RUN_MODE = _runMode;
const Anthropic = require('@anthropic-ai/sdk');
const mammoth = require('mammoth');
const fs = require('fs');
const path = require('path');

const DRY_RUN = process.env.RUN_MODE !== 'production';

const INPUTS_DIR  = path.join(__dirname, '../../inputs/content');
const FREE_DIR    = path.join(__dirname, '../../outputs/content/free');
const PAID_DIR    = path.join(__dirname, '../../outputs/content/paid');

// ── ステージ定義 ──────────────────────────────────
const STAGES = [
  {
    id: 1,
    key: 'stage1',
    name: '告知・精査',
    trigger: '告知を受けた日',
    paid_topics: [
      '主治医への5つの質問テンプレート（告知直後版）',
      '民間保険・がん保険の給付請求 完全手順書',
      '住宅ローン団信の確認フローと銀行への電話スクリプト',
    ],
  },
  {
    id: 2,
    key: 'stage2',
    name: '術前準備',
    trigger: '手術日が確定した日',
    paid_topics: [
      '介護保険の申請書類 記入見本と窓口での言い方',
      '業務引き継ぎ書テンプレートと上司への報告文例',
      '入院費用の概算確認 医事課への電話スクリプト',
    ],
  },
  {
    id: 3,
    key: 'stage3',
    name: '手術・入院',
    trigger: '入院当日',
    paid_topics: [
      '差額ベッド代の支払い拒否 交渉スクリプト',
      '傷病手当金 3者リレー記入見本と提出チェックリスト',
      '退院前カンファレンス 確認10項目シート',
    ],
  },
  {
    id: 4,
    key: 'stage4',
    name: '治療中（化学療法・放射線など）',
    trigger: '初回治療日',
    paid_topics: [
      '高額療養費・多数回該当 月次トラッキングシート',
      '家計インパクト12ヶ月シミュレーター',
      '副作用ピーク日の職場共有テンプレート',
      '傷病手当金 月次申請カレンダーと記入見本',
    ],
  },
  {
    id: 5,
    key: 'stage5',
    name: '治療の効果判定',
    trigger: '効果判定の検査予約が入った日',
    paid_topics: [
      'スキャンパニック対処 待機行動プラン30選',
      '治療変更時の職場再説明テンプレート',
    ],
  },
  {
    id: 6,
    key: 'stage6',
    name: '経過観察・サバイバー＋ケアギバー回復',
    trigger: '治療終了宣言を受けた日',
    paid_topics: [
      '制度申請漏れ防止 9項目チェックリスト（申請書類リンク付き）',
      '職場復帰 合理的配慮確認書テンプレート',
      'ケアギバー自身の健康診断 先送りチェックと受診スクリプト',
    ],
  },
];

// ── Step 1: Word → Markdown 変換 ─────────────────
async function convertFreeContent(stage) {
  // stage番号で始まるdocxファイルをすべて候補にする
  const allFiles = fs.existsSync(INPUTS_DIR)
    ? fs.readdirSync(INPUTS_DIR).filter((f) => f.endsWith('.docx'))
    : [];
  const candidates = [
    `stage${stage.id}_free.docx`,
    `stage${stage.id}.docx`,
    `${stage.key}_free.docx`,
    `${stage.key}.docx`,
    ...allFiles.filter((f) => f.startsWith(`stage${stage.id}_`)),
  ];

  let inputPath = null;
  for (const name of candidates) {
    const p = path.join(INPUTS_DIR, name);
    if (fs.existsSync(p)) { inputPath = p; break; }
  }

  if (!inputPath) {
    console.warn(`[content] stage${stage.id} 無料コンテンツ未配置: inputs/content/ に stage${stage.id}_free.docx を置いてください`);
    return false;
  }

  const outputPath = path.join(FREE_DIR, `stage${stage.id}_${stage.key}_free.md`);
  if (fs.existsSync(outputPath)) {
    console.log(`[content] stage${stage.id} 無料コンテンツ スキップ（既存）`);
    return true;
  }

  const result = await mammoth.convertToMarkdown({ path: inputPath });
  const header = `# ステージ${stage.id}：${stage.name}（無料コンテンツ）\n<!-- trigger: ${stage.trigger} -->\n\n`;
  fs.writeFileSync(outputPath, header + result.value, 'utf8');
  console.log(`[content] stage${stage.id} 無料コンテンツ変換完了 → ${outputPath}`);
  return true;
}

// ── Step 2: Claude API で有料コンテンツ生成 ──────────
async function generatePaidContent(stage, topic) {
  const client = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
  const msg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    messages: [{
      role: 'user',
      content: `難病ナビの有料コンテンツとして、以下のトピックで実務テンプレートを作成してください。

ステージ: ${stage.name}（${stage.trigger}からスタート）
トピック: ${topic}

要件:
- 対象読者: がん患者の家族（ケアギバー）
- 「窓口で何と言うか」「書類のどこに何を書くか」の粒度まで落とす
- すぐコピーペーストできるスクリプト・文例を必ず含める
- 文体は寄り添い型・平易な日本語
- 出力形式: Markdown（見出し・箇条書き・コード引用を活用）

テンプレート本文のみ出力してください。`,
    }],
  });
  return msg.content[0].text.trim();
}

async function processPaidContent(stage) {
  for (const topic of stage.paid_topics) {
    const safeName = topic.replace(/[/\\?%*:|"<>\s]/g, '_').slice(0, 60);
    const outputPath = path.join(PAID_DIR, `stage${stage.id}_${safeName}.md`);

    if (fs.existsSync(outputPath)) {
      console.log(`[content] stage${stage.id} 有料「${topic}」スキップ（既存）`);
      continue;
    }

    console.log(`[content] stage${stage.id} 有料生成中: ${topic}`);

    if (DRY_RUN) {
      fs.writeFileSync(outputPath, `# ${topic}\n\n[dry-run: 未生成]\n`, 'utf8');
      continue;
    }

    const content = await generatePaidContent(stage, topic);
    fs.writeFileSync(outputPath, `# ${topic}\n\n${content}\n`, 'utf8');
    console.log(`[content] stage${stage.id} 有料保存完了: ${outputPath}`);

    await new Promise((r) => setTimeout(r, 1000));
  }
}

// ── メイン ────────────────────────────────────────
async function run() {
  console.log(`[content] 実行モード: ${DRY_RUN ? 'dry-run' : 'production'}`);
  fs.mkdirSync(FREE_DIR, { recursive: true });
  fs.mkdirSync(PAID_DIR, { recursive: true });

  for (const stage of STAGES) {
    console.log(`\n[content] ── ステージ${stage.id}: ${stage.name} ──`);
    await convertFreeContent(stage);
    await processPaidContent(stage);
  }

  console.log('\n[content] 全ステージ完了');
}

run().catch((e) => {
  console.error('[content] 致命的エラー:', e);
  process.exit(1);
});
