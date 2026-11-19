# ロードマップ

設立調査 ([docs/research/](docs/research/))、2026-08-01 の設計レビュー、および 2026-11-19 の戦略再評価（[ADR 0008](docs/decisions/0008-typescript-bun-stack.md) / [ADR 0009](docs/decisions/0009-single-npm-package-release.md) / [ADR 0010](docs/decisions/0010-agent-first-read-only-interface.md)）から導出。domain model は [CONTEXT.md](CONTEXT.md)、決定記録は [docs/decisions/](docs/decisions/) を参照。

プロダクトの軸足は、**ローカルのコーディングエージェント（Claude Code、Codex、Cursor 等）を一次利用者とする read-only の決定論的 事実・証跡エンジン**に置き、段階的に定期・自律エージェントや組織統治へ拡張する。

## M0: feasibility spike CLI (Dependabot、PAT、read-only、Go `v0.1.x`)

**完了 (2026-08-02)**。
技術的 No-go 条件は発火せず、継続可能と判定した。
作者の公開リポジトリ 4 件を dogfooding し、`coverage_gap` 8 件、修正 0 件、`effective` 1 件、scan error 0 件を観測した。
schedule を持つ実リポジトリ 1 件では stalled の誤検出はなかった。
詳細と判定の制約は [M0 dogfooding 結果](docs/validation/2026-08-02-m0-dogfooding.md) に記録した。

- 対象条件: `coverage_gap`、`paused_or_stalled`、`pending` (advisory 参照付きのみ — [ADR 0003](docs/decisions/0003-no-version-resolution.md) の非対称)、`update_open`、`blocked`、`fix_unavailable`、`vulnerable_unpatched` (導出)、および advisory 参照付きの `effective` / `merged_not_effective` (GitHub の alert 自動 resolve を default branch 再評価の証跡として利用)。
- すべての判定は Evidence 連鎖と confirmed / inferred を伴って表 / JSON で出力する。
- stateless なスナップショット実行。DB は持たない (first_observed は alert の `created_at` で代用可能なため)。
- 合否基準 (調査の技術的 No-go 条件の運用形):
  1. すべての `paused_or_stalled` 判定が、人間の監査者が受け入れられる完全な Evidence 連鎖 (schedule + cooldown + activity) を提示できること。
  2. 既知の健全リポジトリ群に対する stalled の誤検出ゼロ (cooldown 解釈込み)。
  3. 停止系は実環境での再現が困難なため、記録済み API fixture で検証すること。

3 項目は実 API 由来の cassette、健全系と病理系の合成 cassette、2026-08-02 の dogfooding で確認した。
設定ありの実リポジトリは 1 件であり、複数件の実証には至っていない。
GitHub API から最終成功 run を直接取得できない制約も残るため、stalled は `inferred` のまま扱い、M1 以降も実対象を増やして誤検出を観測する。

## M0.5 (`v0.2.0`): TypeScript (Bun) 移行 + 単一 npm パッケージ配布化

[ADR 0008](docs/decisions/0008-typescript-bun-stack.md)・[ADR 0009](docs/decisions/0009-single-npm-package-release.md) の適用マイルストーン。新機能やスキーマ拡張は混ぜず、回帰ゼロのクリーンな切替に徹する。

- 既存 M0 相当（Dependabot スキャナ・二層ドメインモデル・table/JSON 出力・終了コード契約）を TypeScript（Bun 開発・テスト・バンドル、Node.js 22+ / Bun 両互換）で再実装する。
- 既存 20 本の録画 HTTP カセット相当の決定論的リプレイテストと認証情報スクラブ検証で、Go 版（`v0.1.6`）との 1:1 出力一致を確認する（非決定性バグ・対象重複の修正を含む）。
- Go 実装・GoReleaser・プラットフォーム別 npm パッケージ（`@depatrol/cli-*`）を退役させ、単一バンドル npm パッケージ（実行時依存極小・lifecycle スクリプト禁止）＋ build-once / attestation / immutable release へ簡素化する。

## M1 (`v0.3.0`): Renovate アダプタ + bot 中立モデル v1 + Agent-friendly CLI & `SKILL.md`

自リポジトリの [renovate.json](renovate.json) を `healthy` 側で dogfooding できる実戦最小ラインと、ローカルコーディングエージェント向け基盤を同時に確立する（[ADR 0010](docs/decisions/0010-agent-first-read-only-interface.md)）。

- **Renovate アダプタ（実戦最小版）**:
  - 標準設定ファイル検出（`renovate.json` / `.github/renovate.json` / `json5` 等）。外部リポジトリの `extends` プリセット展開は行わず、ローカル読取で確定できない設定要素は最弱リンク則に従い `inferred` とする。
  - bot 識別は GitHub App ID、login、label、branch prefix を設定可能にする (self-hosted Renovate 対応)。
  - 標準 Dependency Dashboard issue の構造化セクション解析により Renovate の `pending`（承認待ち・rate limit・schedule 待ち等）を可観測化する。
- **パーサ・ライフサイクル補完**:
  - Dependabot / Renovate 双方の基本 grouped PR 解析（曖昧な紐付けは `inferred`）、`superseded` 状態の追加、`.github/dependabot.yaml`・`directories` glob・`cooldown` 細分化の補完。
  - 両 bot を同一の ExpectedUpdate / Finding モデルで出力する。
- **Agent-friendly CLI & `SKILL.md`**:
  - `schema_version` 付与と JSON Schema 公開、PR 番号 / URL・失敗チェック名・bot 種別等の構造化ポインタ追加。
  - コンテキスト膨張対策の対象絞り込みフィルタ（`--only-unhealthy` 等。※ Evidence を削る `--without-evidence` は不採用）。
  - 間接プロンプトインジェクション（XPIA）防御（PR/Issue 本文の生転載禁止、外部文字列の制御文字除去と長さ上限）。
  - 公式 `SKILL.md`（ドメイン語彙、`confirmed`/`inferred` 境界、`scan_errors` 必読、XPIA 注意）を同梱・公開する。

## M1.5: read-only ローカル stdio MCP (`depatrol mcp`)

M1 完了直後に、単一 npm パッケージ内のサブコマンド `depatrol mcp` として実装する（[ADR 0010](docs/decisions/0010-agent-first-read-only-interface.md)）。

- 公式 TypeScript MCP SDK (`@modelcontextprotocol/sdk`) を用いた最小 read-only ツール群（`scan_repos`、`scan_org`、`get_repository_detail`）＋ドメイン語彙・JSON Schema Resource。全ツールに `readOnlyHint: true`、`destructiveHint: false`、`idempotentHint: true` を設定する。
- 制御付き並列走査＋MCP プロセス内限定のインメモリキャッシュ（`refresh` 指定可）＋`notifications/progress` 進捗通知により、ディスク永続化なし（M0〜M2 ステートレス維持）で対話トリアージの応答性を確保する。
- すべての走査応答に `scan_errors` 全件と確度情報を明示し、Rollup 要約による欠落・過剰確信を防ぐ。

## 需要・実運用検証ゲート（M1 + `depatrol mcp` 完了後）

M1 と `depatrol mcp` が出揃った時点で一度立ち止まり、実リポジトリ群での dogfooding（`depatrol` 自身を含む）および外部公開シグナル（`dependabot-core#2936`、`renovate#25906`、コーディングエージェント利用者のフィードバック）を観測する。

- **優先順の決定**: 実利用のボトルネックが「通常 version update の到達検証・scanner 補完」なら **M2 先行**、「組織 policy / owner / 例外・定期自律エージェント連携」なら **M3 先行** を選択する。
- **技術関門と撤退基準**: `inferred` な stalled の誤検出が行動判断を損ねる場合は技術的 No-go を再評価する。価値が単一領域（config drift のみ、PR 処理のみ等）に集中する場合は既存 OSS（`gh-dep`、`repo-guardian`、DefectDojo 等）への contribution に切り替える。

## M2: default branch 到達検証の一般化（検証ゲート後に優先順確定）

- version update への拡張: 現 default branch の manifest / lockfile 再走査と merge commit 祖先判定の照合。
- GitHub 以外の advisory ソース（scanner adapter — [ADR 0003](docs/decisions/0003-no-version-resolution.md) の第三系統）の導入。OSV-Scanner / dependency-management-data 等とは外部出力を消費する疎結合な adapter として連携する。

## M3: 統治エンジン + 定期・自律エージェント連携（検証ゲート後に優先順確定）

- 統治リポジトリ (YAML) の読み込み: policy、owner マッピング、期限付き例外（[ADR 0004](docs/decisions/0004-governance-as-code.md)）。
- `policy_drift`、`sla_breached`、抑止付き rollup、期限切れ例外の検出。
- 観測キャッシュ DB の導入（「人間の意思決定は git、機械の観測は DB」、Node 22+ / Bun 両互換を維持）。
- 定期・自律エージェント / CI 向け出力（差分イベント JSON、Markdown サマリ、Prometheus metrics）。

## M4: パッケージング・閲覧専用 UI（需要シグナル確認まで凍結）

- read-only GitHub App 化と閲覧専用 Web UI（[ADR 0004](docs/decisions/0004-governance-as-code.md) により統治オブジェクトの編集機能は持たない）。
- リモート HTTP MCP、他 Forge（GitLab / Bitbucket 等）、TUI を含め、エージェント＋CLI/ローカル MCP では満たせない明確な需要シグナルが確認されるまで凍結する。

## 並走: 検証 (個人開発版)

事前 interview と組織 pilot は個人開発では実行困難なため、「最小公開 → シグナル観測」を継続する (2026-08-01 の設計レビューで決定)。

- **技術関門の維持**: M0 の技術的 No-go 条件は 2026-08-02 の検証では発火しなかった。M1 以降も inferred な stalled の誤検出を観測し、Evidence が行動判断に足りなくなった場合は No-go を再評価する。
- **dogfooding を一次検証にする**: 2026-08-02 の初回値は `coverage_gap` 8 件、`paused_or_stalled` 0 件、`blocked` 0 件、`merged_not_effective` 0 件、修正 0 件だった。M1 で Renovate 対応後は自リポジトリを含む対象群で同じ項目を記録する。
- **公開シグナル観測**: M1 + `depatrol mcp` 動作後に既存の要望スレッド (`dependabot-core#2936`、`renovate#25906`) 等で報告し、issue・討論・実利用報告を需要シグナルとして観測する。
- **撤退基準の維持**: 価値が単一領域 (config drift のみ、PR 処理のみ等) に集中する徴候が出たら、新製品を続けず既存 OSS (`gh-dep`、`repo-guardian`、DefectDojo など) への contribution に切り替える。
