# 0004. 統治オブジェクトは governance-as-code、depatrol はどこにも書かない

- ステータス: 採択
- 日付: 2026-08-01

## 背景

domain model の設計レビュー (2026-08-01) で、GitHub から観測できない depatrol 固有の入力 — 組織 policy (`policy_drift` と SLA の判定基準)、owner マッピング、例外レコード (owner・理由・期限) — をどこに置くかが未決だった。

候補は (a) depatrol の DB + 管理 UI/API、(b) git 管理の宣言的 YAML、(c) GitHub の label / issue への記録、の三つ。

## 決定

(b) governance-as-code を採用する。

policy、owner マッピング、例外は、組織の統治リポジトリに置かれた宣言的 YAML として管理する。depatrol はそれを読むだけで、GitHub にも自身の統治状態にも一切書かない。

owner の解決順序は、統治ファイルのマッピングを優先し、無ければ CODEOWNERS にフォールバックする。

## 理由

1. **read-only の理念が自己状態まで一貫する。** depatrol 自身に write 経路が一つも無いことは、「このツールを侵害しても何も書き換えられない」というセキュリティツールとしての信頼性主張を最強にする。
2. **例外の承認フローを既存の仕組みから取り込める。** 例外の承認 = 統治リポジトリへの PR merge。組織のレビュー文化、CODEOWNERS、branch protection がそのまま例外統制になり、監査証跡は git history が担う。
3. **対象ユーザー (Platform Engineering / AppSec) は config-as-code が日常**であり、「もう一つの管理画面とその認証」を嫌う。
4. (a) は認証・認可・監査ログの自前実装を強い、pre-alpha の検証速度と最も相性が悪い。(c) はスキーマ検証ができず散逸する。
5. 4 週間の read-only pilot が UI ゼロで回せる。

## 帰結

- 例外登録の摩擦は UI より高い (YAML + PR)。緊急時に数クリックで黙らせることはできない。これは意図的な摩擦 (例外は監査対象の統治行為) として受け入れる。
- 期限切れ例外の検出は depatrol の Finding として出せる。
- **「人間の意思決定は git、機械の観測は DB」という線引き**を採る。Evidence の履歴 (SLA 計時、first_observed) は統治オブジェクトではなく観測キャッシュであり、depatrol の DB に置いても本決定と矛盾しない。
- M4 の「最小 Web UI」は閲覧専用となり、統治オブジェクトの編集機能を持たない。
