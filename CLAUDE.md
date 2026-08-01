# CLAUDE.md

depatrol: Dependabot / Renovate をリポジトリ横断で監視する read-only control plane (OSS、pre-alpha)。M0 の CLI を v0.1.0 として公開済み (GitHub Releases / go install / npm)。現フェーズは ROADMAP 並走レーンの「最小公開 → シグナル観測」。

- 設立調査は docs/research/2026-08-01-market-research.md。需要、競合、11 状態モデル、MVP 範囲、No-go 条件の根拠がすべてここにある。設計判断はまずこれを参照する。
- 決定記録は docs/decisions/ (ADR 形式)。ライセンスは Apache-2.0 + DCO で採択済み (0001)。実装言語は Go (0002 で採択済み、M0 実装後の記録も追記済み) で、M1 着手前が 0002 の再考ゲート。配布は ADR 0006、手順は docs/runbooks/release.md。リリースはタグ push が唯一の起点。
- ROADMAP.md はドラフト。grilling と spec 化で精査してから確定する。
- コミットメッセージと PR タイトルは英語 (`<type>: <description>` 形式)。
- ブランチ戦略は trunk-based。main を唯一の長命ブランチとし、変更は短命ブランチ (`<type>/<topic>`) からの PR 経由に統一する。最小公開に伴い branch protection を設定済み (required check は ci.yml の `test`、enforce_admins 有効) のため、main への直接 push はできない。
