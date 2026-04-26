const express = require("express");
const line = require("@line/bot-sdk");
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const config = {
  channelSecret: process.env.CHANNEL_SECRET,
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
};

const client = new line.Client(config);
const app = express();

const userState = {};

const stages = [
  "告知・検査中",
  "手術前の準備中",
  "手術・入院中",
  "治療中",
  "効果の確認中",
  "経過観察中",
  "わからない・未確認",
];

// ── 告知時期の選択肢 ──────────────────────────────
const DIAGNOSIS_CHOICES = [
  { label: "1週間以内",  offsetDays: 3   },
  { label: "約1ヶ月前",  offsetDays: 30  },
  { label: "約3ヶ月前",  offsetDays: 90  },
  { label: "約半年前",   offsetDays: 180 },
  { label: "1年以上前",  offsetDays: 400 },
];

function calcDiagnosisDate(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() - offsetDays);
  return d.toISOString().split("T")[0];
}

// ── Q&A 質問定義 ──────────────────────────────────
const questions = {
  "告知・検査中": [
    { text: "職場への報告はもうされましたか？", choices: ["はい", "まだ"] },
    { text: "民間保険の証券は確認できましたか？", choices: ["はい", "まだ"] },
    { text: "住宅ローンはありますか？", choices: ["ある", "ない"] },
  ],
  手術前の準備中: [
    { text: "入院の準備は整っていますか？", choices: ["はい", "まだ"] },
    { text: "手術の説明は医師から受けましたか？", choices: ["はい", "まだ"] },
    { text: "家族への連絡は済んでいますか？", choices: ["はい", "まだ"] },
  ],
  "手術・入院中": [
    { text: "担当医との術前面談はされましたか？", choices: ["はい", "まだ"] },
    { text: "入院中の費用の確認はできていますか？", choices: ["はい", "まだ"] },
    { text: "術後のリハビリ計画は確認しましたか？", choices: ["はい", "まだ"] },
  ],
  治療中: [
    { text: "副作用の対処法は確認していますか？", choices: ["はい", "まだ"] },
    { text: "栄養管理について医師や栄養士に相談しましたか？", choices: ["はい", "まだ"] },
    { text: "治療中の就労や休職について職場と話しましたか？", choices: ["はい", "まだ"] },
  ],
  効果の確認中: [
    { text: "次回の検査日は決まっていますか？", choices: ["はい", "まだ"] },
    { text: "治療の効果について医師から説明を受けましたか？", choices: ["はい", "まだ"] },
    { text: "主治医に気になることを質問できていますか？", choices: ["はい", "まだ"] },
  ],
  経過観察中: [
    { text: "定期検診のスケジュールは把握していますか？", choices: ["はい", "まだ"] },
    { text: "生活習慣の見直しは始めていますか？", choices: ["はい", "まだ"] },
    { text: "職場や家庭での生活は落ち着いてきましたか？", choices: ["はい", "まだ"] },
  ],
  "わからない・未確認": [
    { text: "医師から何らかの診断や説明は受けましたか？", choices: ["はい", "まだ"] },
    { text: "信頼できる身近な人に状況を話せていますか？", choices: ["はい", "まだ"] },
    { text: "今、一番不安に感じていることはお金のことですか？", choices: ["はい", "いいえ"] },
  ],
};

// ── pending_tasks → 配信メッセージのマッピング ────────
// 「まだ」と答えた質問に対応する情報提供メッセージ
const PENDING_TASK_MESSAGES = {
  "職場への報告はもうされましたか？": {
    free: "職場への報告は、タイミングが大切です。\n\n伝える相手：直属の上司→人事の順番で。\n伝える内容：病名・治療期間の目安・休職の可能性の3点だけで十分です。\n\n完璧に説明しようとしなくて大丈夫。「詳細は追ってお伝えします」と言える準備ができていれば進められます。",
    paid: "【サポート情報】職場報告の具体的な文例と、休職・時短勤務の申請手順をまとめました。会社の制度を最大限活用するためのチェックリストもご用意しています。",
  },
  "民間保険の証券は確認できましたか？": {
    free: "民間保険の証券確認は、治療が始まる前に必ず行ってください。\n\n確認ポイント：①入院給付金 ②手術給付金 ③三大疾病特約の有無\n\n証券が見当たらない場合は、保険会社に「契約照会」の電話一本で確認できます。",
    paid: "【サポート情報】保険請求の手順と、請求漏れが多い給付金の一覧をお届けします。診断書1枚で請求できるものから順番に確認できるチェックシート付きです。",
  },
  "住宅ローンはありますか？": {
    free: "住宅ローンがある場合、「団体信用生命保険（団信）」の内容を今すぐ確認してください。\n\nがんと診断されると、保険の種類によっては住宅ローンが免除になるケースがあります。\n\n契約書またはローン会社へ問い合わせを。",
    paid: "【サポート情報】団信の請求手順と、住宅ローン減額・返済猶予の交渉方法についてご案内します。金融機関への相談文例もあわせてお届けします。",
  },
  "入院の準備は整っていますか？": {
    free: "入院準備のチェックリストです。\n\n必須：健康保険証・印鑑・パジャマ・タオル・洗面用具・充電器\n手続き：限度額適用認定証（事前申請で窓口負担が減ります）\n\n申請は加入している健康保険組合または市区町村窓口へ。",
    paid: "【サポート情報】入院中の費用を抑える「限度額適用認定証」の申請方法と、入院前に済ませておくべき手続きを一覧でお届けします。",
  },
  "手術の説明は医師から受けましたか？": {
    free: "手術説明を受ける前に準備しておくと良い質問リストです。\n\n①手術の目的と方法 ②リスクと合併症 ③術後の回復期間 ④仕事復帰の目安 ⑤代替手術の有無\n\n録音の許可を取り、後から聞き直せるようにしておくのがおすすめです。",
    paid: "【サポート情報】手術前に確認すべき同意書の読み方と、セカンドオピニオンを取るべきケースの判断基準をお届けします。",
  },
  "家族への連絡は済んでいますか？": {
    free: "家族への連絡は、できるだけ早い段階で行ってください。\n\n伝え方のポイント：①事実を正確に ②今後の見通し（わかる範囲で）③相手に何をしてほしいか\n\n「心配させたくない」という気持ちはわかりますが、一人で抱えると後が大変になることも。",
    paid: "【サポート情報】家族それぞれへの伝え方（子ども・親・兄弟）の文例集と、家族が動揺したときの対応方法をお届けします。",
  },
  "担当医との術前面談はされましたか？": {
    free: "術前面談では、以下を必ず確認してください。\n\n①麻酔の種類と副作用 ②手術時間と予定入院日数 ③術後の痛みへの対処 ④緊急連絡先\n\n不安な点はその場で全部聞いて大丈夫です。遠慮は不要です。",
    paid: "【サポート情報】術前面談で医師に伝えておくべき情報（アレルギー・常用薬・既往症）の整理シートと、術後の経過観察チェックリストをお届けします。",
  },
  "入院中の費用の確認はできていますか？": {
    free: "入院費用は「高額療養費制度」で上限が設定されています。\n\n所得に応じて月の自己負担が57,600円〜が目安。事前に「限度額適用認定証」を取得すると、窓口での支払いが上限額に抑えられます。\n\n加入保険の窓口へ今すぐ申請を。",
    paid: "【サポート情報】高額療養費の計算方法と、入院中に使える公的給付金・補助制度の一覧をお届けします。申請書類の書き方サポート付きです。",
  },
  "術後のリハビリ計画は確認しましたか？": {
    free: "術後リハビリは、退院後も続くことが多いです。\n\n退院前に確認しておくこと：①リハビリの頻度と場所 ②自宅でできるケア ③次回外来の日程 ④日常生活で気をつけること\n\n担当のリハビリ担当者がいれば、連絡先も確認しておきましょう。",
    paid: "【サポート情報】術後の回復を早める自宅リハビリのポイントと、仕事復帰までのスケジュール管理方法をお届けします。",
  },
  "副作用の対処法は確認していますか？": {
    free: "抗がん剤・放射線治療の主な副作用と対処法です。\n\n・吐き気：食事を少量ずつ・冷たいものが食べやすい\n・倦怠感：無理せず横になる時間を作る\n・口内炎：刺激の少ない食事・こまめなうがい\n\n症状が強い場合は必ず担当医に相談してください。",
    paid: "【サポート情報】副作用ごとの対処法一覧と、担当医に相談するタイミングの判断基準をお届けします。症状の記録シート付きです。",
  },
  "栄養管理について医師や栄養士に相談しましたか？": {
    free: "治療中の食事は、体力の維持に直結します。\n\n基本の考え方：①タンパク質を意識して摂る ②食べられるときに食べる ③水分補給を忘れずに\n\n病院の栄養相談（管理栄養士）は無料で受けられることが多いです。担当医に紹介を依頼してみてください。",
    paid: "【サポート情報】治療ステージ別の食事ガイドと、副作用が出ているときでも食べやすいレシピ集をお届けします。",
  },
  "治療中の就労や休職について職場と話しましたか？": {
    free: "治療と仕事の両立は可能なケースも多いですが、計画が必要です。\n\n選択肢：①休職 ②時短勤務 ③在宅勤務 ④傷病手当金の活用\n\n傷病手当金は、休職中も給与の約2/3が最長1年6ヶ月支給されます。社会保険に加入していれば対象です。",
    paid: "【サポート情報】傷病手当金の申請手順と、職場との交渉で使える伝え方の文例をお届けします。",
  },
  "次回の検査日は決まっていますか？": {
    free: "検査日が決まっていない場合は、早めに担当医に確認してください。\n\n確認すること：①次の検査の種類と目的 ②結果が出るまでの日数 ③結果を聞く診察の予約\n\n検査の予約は混むことがあります。余裕を持ったスケジュールで。",
    paid: "【サポート情報】治療効果の確認で行われる検査の種類と見方、数値の読み方ガイドをお届けします。",
  },
  "治療の効果について医師から説明を受けましたか？": {
    free: "治療効果の説明は、遠慮せず詳しく聞いてください。\n\n聞くべきこと：①効果の判定基準 ②数値が意味すること ③次のステップ ④別の治療の選択肢\n\n「よくわからなかった」は正直に伝えてOK。「もう一度説明してください」と言える権利があります。",
    paid: "【サポート情報】治療効果の判定で使われる指標の解説と、効果が不十分だった場合の次の選択肢についてお届けします。",
  },
  "主治医に気になることを質問できていますか？": {
    free: "主治医への質問は、事前にメモしておくのが鉄則です。\n\n診察は時間が限られています。優先度の高い質問から3つに絞って持参する習慣をつけましょう。\n\n「先生に聞きにくい」と感じたら、看護師や相談員（MSW）に話すのも一つの手です。",
    paid: "【サポート情報】医師との会話を最大限活かすための質問リストテンプレートと、セカンドオピニオンの申し込み方法をお届けします。",
  },
  "定期検診のスケジュールは把握していますか？": {
    free: "経過観察中の定期検診は、再発の早期発見のために欠かせません。\n\n一般的なスケジュール：術後1〜2年は3ヶ月ごと、3〜5年は6ヶ月ごと、その後は年1回。\n\n担当医に「次の検診はいつですか？」と今日確認してください。",
    paid: "【サポート情報】再発の早期サインと、検診前に確認すべき自己チェック項目リストをお届けします。",
  },
  "生活習慣の見直しは始めていますか？": {
    free: "治療後の生活習慣の見直しは、再発リスクを下げる上で重要です。\n\nまず取り組む3つ：①禁煙（喫煙者の場合）②適度な運動（1日30分歩く）③バランスの良い食事\n\n完璧を目指さず、できることから一つずつ始めてください。",
    paid: "【サポート情報】がん再発リスクを下げる生活習慣の科学的根拠と、無理なく続けられる習慣化プログラムをお届けします。",
  },
  "職場や家庭での生活は落ち着いてきましたか？": {
    free: "経過観察期間は、身体の回復と同時に心の整理も必要な時期です。\n\n「治療が終わったのに不安が消えない」という方は多くいます。これは「サバイバーシップ」と呼ばれる自然な反応です。\n\n一人で抱え込まず、信頼できる人や専門家に話してみてください。",
    paid: "【サポート情報】治療後の心理的回復をサポートするセルフケア方法と、無料で使える相談窓口の一覧をお届けします。",
  },
  "医師から何らかの診断や説明は受けましたか？": {
    free: "まだ診断が出ていない場合、不安な気持ちはとても自然なことです。\n\n今できること：①気になる症状をメモしておく ②次の診察日を確認する ③信頼できる人に話を聞いてもらう\n\n一人で抱え込まないことが、この時期はとても大切です。",
    paid: "【サポート情報】診断前の不安を整理するためのワークシートと、医師への相談を上手に進めるためのコミュニケーションガイドをお届けします。",
  },
  "信頼できる身近な人に状況を話せていますか？": {
    free: "一人で抱え込まないことは、心の健康を守る上でとても重要です。\n\n話しにくい場合は：がん相談支援センター（全国のがん診療連携拠点病院に設置）に電話一本で相談できます。\n\n話すことで気持ちが整理されることがあります。",
    paid: "【サポート情報】家族や友人への上手な伝え方と、専門的な心理サポートを受けられる窓口リストをお届けします。",
  },
  "今、一番不安に感じていることはお金のことですか？": {
    free: "お金の不安は、早めに専門家に相談することで解決できることが多いです。\n\n使える制度：①高額療養費制度 ②傷病手当金 ③障害年金 ④医療費控除\n\nまず病院のソーシャルワーカー（MSW）に相談するのが最短ルートです。無料で使えます。",
    paid: "【サポート情報】がん治療にかかる費用の全体像と、利用できる公的支援制度の申請ガイドをまとめてお届けします。",
  },
};

// ── ステージ別配信メッセージ ───────────────────────
// ステージごとに複数日分のメッセージ（順番に配信）
const STAGE_MESSAGES = {
  "告知・検査中": [
    { free: "病名・病期・治療方針の記録\n\n診断を受けた日のことを思い出してください。\n担当医の言葉をどこまで覚えていますか？\n\n今夜、スマホのメモに書いてください。\n・病名・病期 ・治療の方針 ・次の受診日 ・担当医の名前\n\n完璧でなくていい。このメモが後の自分を助けます。", paid: "【有料】次の診察で確認すべき5つの質問と、治療方針の記録テンプレートをお届けします。担当医との会話を最大限活かすための準備ができます。" },
    { free: "家族への伝え方\n\n「なんて言えばいいかわからない」という気持ち、よくわかります。\n\n伝える順番：①事実（病名と治療方針）②今後の見通し ③相手に何をしてほしいか\n\n完璧に伝えなくていい。「一緒に考えてほしい」その一言から始めましょう。", paid: "【有料】家族それぞれへの伝え方文例集（子ども・親・兄弟・職場）と、家族が動揺したときの対処法をお届けします。" },
    { free: "セカンドオピニオンについて\n\n治療方針に迷いがある場合、セカンドオピニオンは当然の権利です。\n\n主治医への伝え方：「他の先生の意見も聞いてみたい」でOK。\n紹介状と検査データを用意してもらえば進められます。", paid: "【有料】セカンドオピニオンを受けるべきケースの判断基準と、スムーズに進めるための手順書をお届けします。" },
    { free: "医療費の全体像を把握する\n\nがん治療の費用は高額になりますが、制度を使えば負担を減らせます。\n\n最初に確認すること：①加入している保険の種類 ②高額療養費制度の限度額 ③民間保険の給付条件\n\n「お金が心配」なら、病院のソーシャルワーカーへ。無料で相談できます。", paid: "【有料】治療費の試算シートと、使える支援制度の全リストをお届けします。申請の優先順位がわかります。" },
    { free: "治療スケジュールの全体像\n\nこれからの治療の流れを把握しておくことで、気持ちが落ち着きます。\n\n担当医に確認すること：①治療の種類と順番 ②各治療の期間 ③副作用の時期 ④仕事・生活への影響\n\n「全部は無理でも、次の1ステップだけ」を意識しましょう。", paid: "【有料】治療スケジュール管理ツールと、副作用が出やすい時期の対策カレンダーをお届けします。" },
  ],
  手術前の準備中: [
    { free: "手術前の準備チェックリスト\n\n入院までに済ませておくこと：\n①限度額適用認定証の申請（高額療養費の窓口負担を減らす）\n②民間保険会社への連絡\n③職場への入院期間の連絡\n④自宅の家事・育児の手配\n\n一つずつ確認していきましょう。", paid: "【有料】入院前の手続き完全チェックリストと、各手続きの具体的な手順書をお届けします。" },
    { free: "麻酔と手術のリスクについて\n\n手術前に担当医に確認すること：\n①麻酔の種類と副作用\n②手術時間の目安\n③考えられるリスクと対処\n④術後の痛みへの対応\n\n「怖い」と感じるのは当然のことです。疑問は全部聞いてください。", paid: "【有料】術前面談で聞くべき質問リストと、手術同意書の読み方ガイドをお届けします。" },
    { free: "家族のサポート体制を整える\n\n手術・入院中、家族が不在になる場合は事前の準備が大切です。\n\n確認事項：①子どものお迎え・食事の手配 ②親の介護がある場合の代替手配 ③入院中の連絡先の共有\n\n「頼ること」は弱さではありません。周りを上手に使いましょう。", paid: "【有料】入院中の家族サポート計画テンプレートと、公的な一時的ヘルパー支援の申請方法をお届けします。" },
  ],
  "手術・入院中": [
    { free: "入院中の費用管理\n\n入院費の支払いは退院時にまとめてくることが多いです。\n\n限度額適用認定証があれば窓口での支払いが上限額に。\n申請がまだの場合は、今からでも加入保険へ連絡を。\n\n食事代・差額ベッド代は別途かかる場合があります。", paid: "【有料】入院費の内訳の読み方と、退院後に請求できる給付金・還付金のリストをお届けします。" },
    { free: "術後の回復について\n\n手術後は体が回復しようとしています。焦らないことが大切です。\n\n今日できること：①担当医・看護師への報告（痛み・違和感）②無理のない範囲での歩行③水分補給\n\n「思ったより辛い」も「意外と大丈夫」も、どちらも正常です。", paid: "【有料】術後の回復を助けるセルフケアガイドと、退院に向けたリハビリ計画の立て方をお届けします。" },
    { free: "退院後の生活に向けて\n\n退院前に確認しておくこと：\n①自宅でのケア方法（傷の処置など）\n②次回外来の日程\n③緊急時の連絡先\n④日常生活で気をつけること（食事・入浴・運動）\n\n退院は「ゴール」ではなく「次のスタート」です。", paid: "【有料】退院後の生活チェックリストと、職場復帰・家事復帰のための段階的なプログラムをお届けします。" },
  ],
  治療中: [
    { free: "副作用との付き合い方\n\n副作用は人によって大きく違います。「こんなものかな」と思わず、辛いときは担当医に伝えてください。\n\n今すぐできること：\n①症状をメモする（いつ・どんな症状・強さ）\n②次の診察で報告する\n\n我慢は美徳ではありません。", paid: "【有料】副作用別の対処法一覧と、担当医への報告を上手に行うための記録シートをお届けします。" },
    { free: "治療中の食事の工夫\n\n食欲が落ちているとき、無理に食べなくてOKです。\n\n食べやすいもの：冷たいもの・さっぱりしたもの・少量ずつ\n避けたいもの：強い香り・脂っこいもの・アルコール\n\n「今日は何も食べられなかった」という日があっても、翌日また試してみましょう。", paid: "【有料】治療中でも食べやすいレシピ集と、栄養を効率よく摂るための食事計画をお届けします。" },
    { free: "心の疲れに気づく\n\n治療中は体だけでなく、心も疲れています。\n\nこんな状態が続いていませんか：\n・ずっと不安で眠れない\n・何をしても楽しくない\n・誰とも話したくない\n\n2週間以上続く場合は、担当医や心理士への相談を検討してください。", paid: "【有料】がん治療中のメンタルケアガイドと、専門的なサポートを受けられる窓口リストをお届けします。" },
  ],
  効果の確認中: [
    { free: "検査結果を正しく受け取る\n\n検査結果の数値に一喜一憂するのは自然なことですが、1回の数値だけで判断しないことが大切です。\n\n担当医に確認すること：\n①この数値は何を意味するか\n②前回と比べてどうか\n③次のステップは何か", paid: "【有料】よく使われる腫瘍マーカー・検査値の解説と、担当医への効果的な質問リストをお届けします。" },
    { free: "次の治療の選択肢を知る\n\n治療効果の確認後、次のステップについて話し合いが始まることがあります。\n\n焦らず、選択肢を一つずつ確認してください。\n「決める前にもう一度考えたい」と言う権利があります。\n\nセカンドオピニオンを取ることも選択肢の一つです。", paid: "【有料】治療効果が不十分だった場合の次の選択肢と、各治療法の比較ガイドをお届けします。" },
    { free: "日常生活を少しずつ取り戻す\n\n効果確認の段階では、少しずつ日常生活を広げていける時期です。\n\nおすすめの取り組み：\n①短い距離の散歩から始める\n②好きなことを少しだけやってみる\n③外食や友人との交流を再開する\n\n無理のないペースで。", paid: "【有料】体力回復プログラムと、日常生活を安全に再開するためのガイドラインをお届けします。" },
  ],
  経過観察中: [
    { free: "定期検診を習慣にする\n\n経過観察中の検診は、再発の早期発見のための大切な機会です。\n\n受診のポイント：\n①予約を先に入れておく（忘れない仕組み）\n②受診前に気になる症状をメモ\n③結果を必ず記録する\n\n「異常なし」の確認も、あなたの安心につながります。", paid: "【有料】再発の早期サインと定期検診の準備チェックリスト、検査結果の記録テンプレートをお届けします。" },
    { free: "体と心のメンテナンス\n\n経過観察期間は、治療の疲れが出やすい時期でもあります。\n\n今から始めたい習慣：\n①週3回以上の軽い運動\n②睡眠7時間の確保\n③好きなことに時間を使う\n\n「元通り」を目指さず、「今のベスト」を探しましょう。", paid: "【有料】がん経験者向けの生活習慣改善プログラムと、再発リスクを下げるためのエビデンスに基づいたガイドをお届けします。" },
    { free: "これからの人生を考える\n\nがんという経験を経て、人生の優先順位が変わったと感じる方は多くいます。\n\n今、自分に問いかけてみてください：\n「これからどんなことに時間を使いたいか」\n「大切にしたいものは何か」\n\nその答えを少しずつ言葉にしてみましょう。", paid: "【有料】がん経験後の人生設計ワークシートと、キャリア・家族・お金の見直しガイドをお届けします。" },
  ],
  "わからない・未確認": [
    { free: "今、あなたにできること\n\n状況がまだはっきりしていない時期は、不安が一番大きくなりがちです。\n\n今日できる小さな一歩：\n①気になる症状をメモする\n②かかりつけ医に相談の予約を入れる\n③信頼できる人に話してみる\n\n一人で抱え込まないことが一番大切です。", paid: "【有料】症状の整理シートと、医師への相談を上手に進めるためのコミュニケーションガイドをお届けします。" },
    { free: "相談できる窓口を知っておく\n\n「どこに相談すればいいかわからない」という方へ。\n\n使える窓口：\n①がん相談支援センター（全国のがん拠点病院・無料）\n②よりそいホットライン：0120-279-338（24時間）\n③地域の保健センター\n\n相談することは勇気が要りますが、その一歩が状況を変えます。", paid: "【有料】地域ごとの相談窓口リストと、初めての相談で話すべき内容の整理シートをお届けします。" },
    { free: "お金の不安への対処法\n\n「治療費が心配で、受診をためらっている」という方は少なくありません。\n\nまず知ってほしいこと：\n①健康保険があれば、まず3割負担\n②高額療養費制度で月の上限あり\n③病院のソーシャルワーカー（MSW）に相談すれば、支援制度を一緒に探してくれる\n\nお金が理由で受診を遅らせないでください。", paid: "【有料】受診・治療費の不安を解消するための支援制度完全ガイドをお届けします。" },
  ],
};

// ── 日曜バーンアウトチェックメッセージ ────────────
const BURNOUT_MESSAGE = {
  free: "今週もお疲れさまでした。\n\n少しだけ、自分のことを振り返ってみてください。\n\n□ 今週、誰かと話せましたか？\n□ 今週、好きなことを少しでもできましたか？\n□ 今の自分のストレスは10点満点で何点ですか？\n\n7点以上なら、少し立ち止まるサインです。今週末は意識して休んでみてください。",
  paid: "【有料】バーンアウト（燃え尽き）を防ぐためのセルフケアプログラムと、ストレスが高いときの対処法をお届けします。専門家監修のチェックリスト付きです。",
};

// ── pending_tasks の抽出 ──────────────────────────
// answers の中から「まだ」「ある」と答えた質問をpending_tasksとして抽出
function extractPendingTasks(answers) {
  const PENDING_KEYWORDS = ["まだ", "ある"];
  return Object.entries(answers)
    .filter(([, answer]) => PENDING_KEYWORDS.includes(answer))
    .map(([question]) => question);
}

// ── delivery_queue の生成 ─────────────────────────
function buildDeliveryQueue(lineId, stage, pendingTasks, plan = "free") {
  const queue = [];
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);

  let dayOffset = 0;

  const addMessages = (free, paid, messageType) => {
    const date = new Date(tomorrow);
    date.setDate(date.getDate() + dayOffset);
    const isSunday = date.getDay() === 0;
    const scheduledDate = date.toISOString().split("T")[0];

    if (isSunday) {
      // 日曜はバーンアウトチェックに差し替え
      queue.push({
        line_id:        lineId,
        scheduled_date: scheduledDate,
        message_type:   "burnout",
        content:        BURNOUT_MESSAGE.free,
        plan_type:      "free",
        sent:           false,
      });
      if (plan === "paid") {
        queue.push({
          line_id:        lineId,
          scheduled_date: scheduledDate,
          message_type:   "burnout",
          content:        BURNOUT_MESSAGE.paid,
          plan_type:      "paid",
          sent:           false,
        });
      }
      dayOffset++;
      // 翌日に通常メッセージを送る
      const nextDate = new Date(tomorrow);
      nextDate.setDate(nextDate.getDate() + dayOffset);
      const nextScheduledDate = nextDate.toISOString().split("T")[0];
      queue.push({
        line_id:        lineId,
        scheduled_date: nextScheduledDate,
        message_type:   messageType,
        content:        free,
        plan_type:      "free",
        sent:           false,
      });
      if (plan === "paid") {
        queue.push({
          line_id:        lineId,
          scheduled_date: nextScheduledDate,
          message_type:   messageType,
          content:        paid,
          plan_type:      "paid",
          sent:           false,
        });
      }
    } else {
      queue.push({
        line_id:        lineId,
        scheduled_date: scheduledDate,
        message_type:   messageType,
        content:        free,
        plan_type:      "free",
        sent:           false,
      });
      if (plan === "paid") {
        queue.push({
          line_id:        lineId,
          scheduled_date: scheduledDate,
          message_type:   messageType,
          content:        paid,
          plan_type:      "paid",
          sent:           false,
        });
      }
    }
    dayOffset++;
  };

  // ① pending_tasks 分を先に配信
  for (const task of pendingTasks) {
    const msg = PENDING_TASK_MESSAGES[task];
    if (msg) {
      addMessages(msg.free, msg.paid, "pending_task");
    }
  }

  // ② ステージ別メッセージを続けて配信
  const stageMsgs = STAGE_MESSAGES[stage] || [];
  for (const msg of stageMsgs) {
    addMessages(msg.free, msg.paid, "stage");
  }

  return queue;
}

// ── Webhook ───────────────────────────────────────
app.post("/webhook", line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then(() => res.json({ status: "ok" }))
    .catch((err) => res.status(500).end());
});

// ── 診断時期を質問する ────────────────────────────
async function askDiagnosisDate(replyToken) {
  return client.replyMessage(replyToken, {
    type: "text",
    text: "告知はいつ頃でしたか？",
    quickReply: {
      items: DIAGNOSIS_CHOICES.map((c) => ({
        type: "action",
        action: { type: "message", label: c.label, text: c.label },
      })),
    },
  });
}

// ── Q&A を順番に送る ─────────────────────────────
async function sendNextQuestion(replyToken, userId) {
  const state = userState[userId];
  const stageQuestions = questions[state.stage];
  const currentIndex = state.questionIndex;

  if (currentIndex < stageQuestions.length) {
    const q = stageQuestions[currentIndex];
    return client.replyMessage(replyToken, {
      type: "text",
      text: q.text,
      quickReply: {
        items: q.choices.map((choice) => ({
          type: "action",
          action: { type: "message", label: choice, text: choice },
        })),
      },
    });
  }

  // ── 全問完了 ─────────────────────────────────
  const pendingTasks = extractPendingTasks(state.answers);
  const plan = "free"; // 有料プラン判定は今後実装

  // ① onboardings に保存
  const { error: onboardingErr } = await supabase
    .from("onboardings")
    .upsert(
      {
        user_id:         userId,
        line_id:         userId,
        stage:           state.stage,
        diagnosis_date:  state.diagnosis_date,
        answers:         state.answers,
        pending_tasks:   pendingTasks,
        plan:            plan,
        alert_scheduled: false,
      },
      { onConflict: "user_id" }
    );
  if (onboardingErr) {
    console.error("[onboarding] 保存エラー:", onboardingErr.message);
  }

  // ② delivery_queue を生成して挿入
  const queue = buildDeliveryQueue(userId, state.stage, pendingTasks, plan);
  if (queue.length > 0) {
    const { error: queueErr } = await supabase
      .from("delivery_queue")
      .insert(queue);
    if (queueErr) {
      console.error("[delivery_queue] 挿入エラー:", queueErr.message);
    }
  }

  delete userState[userId];
  return client.replyMessage(replyToken, {
    type: "text",
    text: "わかりました。明日朝7:00から、まだ終わっていないことから順番にお届けします。",
  });
}

async function handleEvent(event) {
  if (event.type === "follow") {
    const userId = event.source.userId;
    return client.pushMessage(userId, {
      type: "text",
      text: "さいごに1つだけ教えてください。\n今、どの状況ですか？\n\n選んでいただいた状況に合わせたメッセージを明日からお送りします。",
      quickReply: {
        items: stages.map((stage) => ({
          type: "action",
          action: { type: "message", label: stage, text: stage },
        })),
      },
    });
  }

  if (event.type !== "message" || event.message.type !== "text") return;

  const userId = event.source.userId;
  const userText = event.message.text;

  // ── ステージ選択 → 診断時期を質問 ────────────────
  if (stages.includes(userText)) {
    userState[userId] = {
      stage:          userText,
      phase:          "diagnosis_date",
      questionIndex:  0,
      answers:        {},
      diagnosis_date: null,
    };
    return askDiagnosisDate(event.replyToken);
  }

  if (userState[userId]) {
    const state = userState[userId];

    // ── 診断時期の回答 ────────────────────────────
    if (state.phase === "diagnosis_date") {
      const choice = DIAGNOSIS_CHOICES.find((c) => c.label === userText);
      if (choice) {
        state.diagnosis_date = calcDiagnosisDate(choice.offsetDays);
        state.phase = "questions";
        return sendNextQuestion(event.replyToken, userId);
      }
      return askDiagnosisDate(event.replyToken);
    }

    // ── Q&A の回答 ───────────────────────────────
    if (state.phase === "questions") {
      const stageQuestions = questions[state.stage];
      const currentQuestion = stageQuestions[state.questionIndex];
      state.answers[currentQuestion.text] = userText;
      state.questionIndex += 1;
      return sendNextQuestion(event.replyToken, userId);
    }
  }

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: "現在の状況を教えてください。",
    quickReply: {
      items: stages.map((stage) => ({
        type: "action",
        action: { type: "message", label: stage, text: stage },
      })),
    },
  });
}

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Bot running on port ${port}`));
