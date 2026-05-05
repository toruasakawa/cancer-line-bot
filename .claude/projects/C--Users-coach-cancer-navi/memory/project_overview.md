---
name: cancer_navi project overview
description: Overview of the cancer_navi LINE service project for cancer patient families
type: project
---

cancer_navi はがん患者の家族向けLINEサービス。

**Why:** がん診断直後から治療中・治療後にわたり、家族が必要な情報・サポートにアクセスできるよう支援するため。

**Tech stack:** Node.js / Supabase / Vercel (Serverless) / LINE Messaging API

**How to apply:** 新機能提案やアーキテクチャ判断はこのスタックに沿って行う。LINEのWebhookはVercelのAPI Routesで受け取り、データはSupabaseに保存する構成。
