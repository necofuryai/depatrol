# 0008. v0.2.0 以降、実装言語・ツールチェーンを TypeScript (Bun) へ移行する

- ステータス: 採択（v0.2.0 で適用予定）
- 日付: 2026-11-19
- 置換対象: [ADR 0002](0002-stack.md)（実装言語に関する決定。M0 技術関門における `inferred` 制約は維持する）

## 背景

[ADR 0002](0002-stack.md) は 2026-08-01 に Go を採択し、2026-08-02 の M0 完了時点で再考ゲートを通過した。しかし M0 完了後の運用実績と 2026-11-19 の戦略再評価で、前提条件が大きく変化した。

1. **プロダクト軸足の再定義**: ローカルのコーディングエージェント（Claude Code、Codex、Cursor 等）を一次利用者とする AI エージェント前提の read-only 運用・トリアージ基盤へ軸足を移すことを決定した（[ADR 0010](0010-agent-first-read-only-interface.md)）。
2. **単独メンテナの開発速度と保守構造のねじれ**: 2026-08-02 の M0 完了以降、Go 本体（`main.go` + `internal/` 計 1,594 行、テスト 878 行）の機能開発が約 3.5 か月停止した一方、Node.js / shell で書かれた配布・リリース基盤（`scripts/` + `packaging/` 約 2,800 行）の保守が本体規模を上回った。ADR 0002 が認めていた通り作者の最速言語は TypeScript であり、本体が小さい pre-alpha 段階こそが移行コスト最小の窓である。
3. **M2 外部連携の再評価**: M2 で連携候補としている OSV-Scanner / dependency-management-data (DMD) を Go ライブラリとして直接組み込む方針は、極小依存・軽量バイナリという利点と衝突する。実務上は外部出力を消費する疎結合な scanner adapter 連携が妥当であり、Go 継続の固有誘因が薄れた。

## 決定

1. `v0.2.0` 以降、depatrol の実装言語を **TypeScript**、開発・テスト・バンドルの標準ツールチェーンを **Bun** とする。
2. 実行コードは **Node.js 22+ と Bun の双方で動作する**標準 API（Web `fetch` 等）および最小限の Node 互換モジュールに限定し、Bun 固有ランタイム API へのロックインを避ける（配布契約は [ADR 0009](0009-single-npm-package-release.md)）。
3. 実行時依存は極小に抑える。GitHub REST API クライアントは標準 `fetch` ベースの薄い実装（rate limit・secondary rate limit・全ページネーション・truncated tree 拒否を内包）とし、単一バンドルへ取り込む。
4. 移行は二段階で実施する。
   - **第 1 段（`v0.2.0`）**: 同一リポジトリで既存 M0 相当（Dependabot スキャナ・二層モデル・table/JSON 出力・終了コード契約）を TypeScript でクリーンに再実装し、既存 20 本の録画 HTTP カセット相当の決定論的リプレイテストで 1:1 の出力一致を検証した上で、Go 実装・GoReleaser・6 パッケージ配布を一括退役させる。
   - **第 2 段（M1 / `v0.3.0`）**: 移行完了後に bot 中立モデル v1（Renovate アダプタ・エージェント向け構造化ポインタ・`SKILL.md`）へ進む。
5. 以下の不変条件は言語移行後も変更しない: [ADR 0001](0001-license.md)（Apache-2.0 + DCO）、[ADR 0003](0003-no-version-resolution.md)（自前 version 解決禁止）、[ADR 0004](0004-governance-as-code.md)（read-only / governance-as-code）、[ADR 0005](0005-two-layer-domain-model.md)（二層モデル・Evidence・最弱リンク則）、および [ADR 0002](0002-stack.md) の `inferred` 制約（`inferred` な stalled を自動修正や policy gate の確定根拠に使わない）。

## 理由

1. 単独メンテナの最大課題である「M1 機能開発と実需要検証への到達速度」を、作者の最速言語である TypeScript (Bun) で最大化できる。
2. 一次利用者であるローカルのコーディングエージェント環境は Node.js / Bun を標準的に備えており、単一 npm パッケージ配布（ADR 0009）と公式 TypeScript MCP SDK（`@modelcontextprotocol/sdk`）の親和性が高い。
3. TypeScript の直和型・スキーマ定義は、エージェント向け JSON 契約・JSON Schema 公開・M1 の bot 中立モデルと好相性である。
4. アプリケーション本体と CI / リリーススクリプトの言語を統一することで、Go + Node の二言語ツールチェーン保守負債を解消できる。
5. `v0.2.0` でまず M0 挙動の 1:1 移植に絞ることで、移行による回帰検証と M1 の仕様変更を清潔に分離できる。

## 退けた代替案

- **(a) Go を継続する**: 単一静的バイナリ・`go install`・極小依存は強いが、作者の開発速度と二言語保守（Go 本体＋Node 配布基盤）の摩擦が残る。
- **(b) Bun 専用（Node 非互換）とする**: `Bun.*` API を直接使える反面、`npx depatrol` や Node 22+ のみの CI / コーディングエージェント環境を切り捨てる摩擦が大きい。
- **(c) Go と TypeScript を同一リポジトリで長期併存させる**: ドメインモデル・カセットテスト・配布経路の二重保守が発生する。
- **(d) TS 移行と M1（Renovate＋スキーマ拡張）を同時に行う**: M0 挙動の回帰検証と新仕様の不具合が混ざり、切替コストと品質リスクが跳ね上がる。

## 帰結

- `go install` および GoReleaser によるネイティブ静的バイナリ配布は `v0.2.0` で終了する。
- 録画 HTTP テストは `go-vcr.v4` から TypeScript 上の決定論的 HTTP リプレイ基盤（既存 20 カセット YAML の読込または 1:1 変換＋認証情報スクラブ検証）へ移行する。
- M2 で連携する OSV-Scanner / DMD は Go ライブラリ直結ではなく、外部出力を消費する疎結合な scanner adapter として設計する。
- M3 で観測キャッシュ DB を導入する際は、Node.js 22+ / Bun 両互換を維持できる SQLite 境界を選定する。
