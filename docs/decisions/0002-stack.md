# 0002. 実装言語とアーキテクチャ

- ステータス: 検討中 (未決)
- 日付: 2026-08-01

## 背景

feasibility spike CLI から始め、将来は read-only GitHub App と最小 Web UI まで育てる。

候補は TypeScript (Node 22)、Go、Rust。

決定は急がず、評価プロセスを経てから ADR として採択する。

## 評価基準 (ドラフト)

- GitHub API クライアントの成熟度: octokit (TS)、go-github + githubv4 (Go)、octocrab (Rust)。alert 系は REST、PR timeline の一括取得は GraphQL が効率的なため、両対応が必要。
- 配布形態: CLI は単一バイナリ配布が望ましい (Go / Rust 有利)。GitHub App / 常駐サービスへの発展 (TS / Go 有利)。
- organization 横断走査の並行処理と rate limit 制御の書きやすさ。
- dependency-management-data (Go 製) との連携形態: ライブラリ連携なら Go、プロセス / データ連携なら言語を問わない。
- コントリビューター獲得: この分野の隣接 OSS は Go が多い。
- 作者の習熟度と開発速度: TS が最速、Rust は学習コスト込み。
- 型安全性と長期保守性。

## 決定プロセス

1. grilling で要件と制約を出し切る。
2. 必要なら同一の API 呼び出しセット (alert 取得、PR 列挙、merge 祖先判定) を各候補で最小実装して比較する。
3. 結果を本 ADR に追記し、ステータスを「採択」に変える。
