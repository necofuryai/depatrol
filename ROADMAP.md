# ロードマップ

設立調査 (docs/research/) と 2026-08-01 の grilling から導出。domain model は CONTEXT.md、決定記録は docs/decisions/ を参照。

## M0: feasibility spike CLI (Dependabot、PAT、read-only)

**完了 (2026-08-02)**。
技術的 No-go 条件は発火せず、M1 へ継続可能と判定した。
作者の公開リポジトリ4件を dogfooding し、`coverage_gap` 8件、修正0件、`effective` 1件、scan error 0件を観測した。
schedule を持つ実リポジトリ1件では stalled の誤検出はなかった。
詳細と判定の制約は [M0 dogfooding 結果](docs/validation/2026-08-02-m0-dogfooding.md) に記録した。

- 対象条件: `coverage_gap`、`paused_or_stalled`、`pending` (advisory 参照付きのみ — ADR 0003 の非対称)、`update_open`、`blocked`、`fix_unavailable`、`vulnerable_unpatched` (導出)、および advisory 参照付きの `effective` / `merged_not_effective` (GitHub の alert 自動 resolve を default branch 再評価の証跡として利用)。
- すべての判定は Evidence 連鎖と confirmed / inferred を伴って表 / JSON で出力する。
- 除外: `policy_drift`・`sla_breached`・`exception_active` (統治オブジェクトが必要 → M3)、version update の `effective` / `merged_not_effective` (再走査が必要 → M2)、Renovate (→ M1)。
- stateless なスナップショット実行。DB は持たない (first_observed は alert の `created_at` で代用可能なため)。
- 合否基準 (調査の技術的 No-go 条件の運用形):
  1. すべての `paused_or_stalled` 判定が、人間の監査者が受け入れられる完全な Evidence 連鎖 (schedule + cooldown + activity) を提示できること。
  2. 既知の健全リポジトリ群に対する stalled の誤検出ゼロ (cooldown 解釈込み)。
  3. 停止系は実環境での再現が困難なため、記録済み API fixture で検証すること。

3項目は実 API 由来の cassette、健全系と病理系の合成 cassette、2026-08-02 の dogfooding で確認した。
設定ありの実リポジトリは1件であり、複数件の実証には至っていない。
GitHub API から最終成功 run を直接取得できない制約も残るため、stalled は `inferred` のまま扱い、M1 以降も実対象を増やして誤検出を観測する。

## M1: Renovate adapter + bot 中立モデル v1

- bot 識別は GitHub App ID、login、label、branch prefix を設定可能にする (self-hosted Renovate は login を変えられるため)。
- Dependency Dashboard issue の解析により Renovate の `pending` を可観測にする。
- 両 bot を同一の ExpectedUpdate / Finding モデルで出力する。

## M2: default branch 到達検証の一般化

- version update への拡張: 現 default branch の manifest / lockfile 再走査 (OSV-Scanner または dependency-management-data 連携) と merge commit 祖先判定の照合。
- GitHub 以外の advisory ソース (scanner adapter — ADR 0003 の第三系統) の導入。

## M3: 統治エンジン

- 統治リポジトリ (YAML) の読み込み: policy、owner マッピング、例外 (ADR 0004)。
- `policy_drift`、`sla_breached`、抑止付き rollup、期限切れ例外の検出。
- 観測キャッシュ DB の導入 (「人間の意思決定は git、機械の観測は DB」)。
- JSON と Prometheus metrics の出力。

## M4: パッケージング

- read-only GitHub App 化と閲覧専用 Web UI (ADR 0004 により統治オブジェクトの編集機能は持たない)。

## 並走: 検証 (個人開発版)

事前 interview と組織 pilot は個人開発では実行困難なため、「最小公開 → シグナル観測」に置き換える (2026-08-01 grilling で決定)。

- **技術関門の維持**: M0 の技術的 No-go 条件は 2026-08-02 の検証では発火しなかった。M1 以降も inferred な stalled の誤検出を観測し、Evidence が行動判断に足りなくなった場合は No-go を再評価する。
- **dogfooding を一次検証にする**: 2026-08-02 の初回値は `coverage_gap` 8件、`paused_or_stalled` 0件、`blocked` 0件、`merged_not_effective` 0件、修正0件だった。以後も同じ項目を記録する。
- **公開シグナル観測**: M0 動作後に公開し、既存の要望スレッド (dependabot-core issue #2936、renovate discussion #25906) で報告。issue、討論、実利用報告を需要シグナルとして観測する。
- **撤退基準の維持**: 価値が単一領域 (config drift のみ、PR 処理のみ等) に集中する徴候が出たら、新製品を続けず既存 OSS (gh-dep、repo-guardian、DefectDojo など) への contribution に切り替える。
