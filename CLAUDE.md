# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# 難病ナビ 自動化プロジェクト

## 技術スタック
- Runtime: Node.js 18+
- 言語: JavaScript (CommonJS)
- DB: Supabase (PostgreSQL)
- デプロイ: Vercel Cron

## 各スクリプトの役割

### scripts/kpi/
- ⑥KPIシートの指標をX API・LINE Messaging API・note APIから取得
- 毎月1日に実行するバッチ
- 出力: outputs/kpi_YYYYMM.csv

### scripts/sns/
- X API v2でツイートをスケジュール投稿
- 深夜3時間帯（23:00/0:00/1:00）に対応
- コピー生成はClaude APIを使う

### scripts/content/
- ③シートのプロンプト骨子21件をClaude APIに投げる
- 出力はoutputs/content/以下にマークダウンで保存

### scripts/alerts/
- オンボーディング回答からアラート日程を計算
- Supabaseのalert_scheduleテーブルに投入

### scripts/seo/
- 厚労省・難病情報センターのRSSを週次取得
- 変更検知時はSlack Webhookで通知

## サービス設計の背景

### サービス概要
- がん患者家族向けLINEサービス「難病ナビ」
- LINEフォロー時にオンボーディングを実施し、ステージ・診断時期・未完了タスクを収集

### システム構成
- **Render**（index.js）: LINE Webhookサーバー・オンボーディング処理
- **Supabase**: onboardings・delivery_queue・alert_scheduleなどのデータ管理
- **Vercel / GitHub Actions**: 自動バッチ処理（SEO・KPI・アラート・SNS）

### 配信設計
- `delivery_queue` テーブルで配信スケジュールを一元管理
- 無料/有料の2段階配信
  - 7:00 JST: 無料コンテンツ（全ユーザー）
  - 7:30 JST: 有料コンテンツ（plan='paid' のユーザーのみ）
- 配信順序
  1. **pending_tasks**（前ステージの未完了タスク）を先に配信
  2. pending_tasks完了後、**ステージ別文章**に移行
- 毎日曜日はバーンアウトチェック文章に差し替え
- 送信済みは `sent=true` で管理、重複送信を防止

### Supabaseテーブル構成
| テーブル | 役割 |
|---|---|
| onboardings | LINEユーザーのステージ・回答・pending_tasks・planを保存 |
| delivery_queue | 配信スケジュール（line_id・日付・本文・plan_type・sent） |
| alert_schedule | アラート日程（診断日ベースのフォローアップ） |
| kpi_monthly | 月次KPI（X・LINE・noteのフォロワー数等） |
| seo_seen_urls | SEO監視済みURLの重複チェック |
| sns_post_log | X投稿ログ |

### Renderの定期実行（Cron Job）
- `node cron.js free`  → `0 22 * * *`（JST 7:00）
- `node cron.js paid`  → `30 22 * * *`（JST 7:30）

## 絶対に守るルール
- .envファイルは読まない・出力しない
- git commit・git pushはしない（人間が判断する）
- Supabaseの本番DBには直接接続しない（開発用URLを使う）
- 外部APIへのリクエストはdry-runモードで確認してから本番実行
