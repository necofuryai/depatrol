# CLAUDE.md

depatrol: Dependabot / Renovate をリポジトリ横断で監視する read-only control plane (OSS、pre-alpha 設計フェーズ)。

- 設立調査は docs/research/2026-08-01-market-research.md。需要、競合、11 状態モデル、MVP 範囲、No-go 条件の根拠がすべてここにある。設計判断はまずこれを参照する。
- 決定記録は docs/decisions/ (ADR 形式)。ライセンスは Apache-2.0 + DCO で採択済み (0001)。実装言語は Go (0002 で採択済み)。M0 完了時に苦痛点を 0002 に追記し、M1 着手前を再考ゲートとする。
- ROADMAP.md はドラフト。grilling と spec 化で精査してから確定する。
- コミットメッセージと PR タイトルは英語 (`<type>: <description>` 形式)。
