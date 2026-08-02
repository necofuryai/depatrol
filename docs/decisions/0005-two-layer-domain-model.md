# 0005. domain model は Finding 分類法 + ExpectedUpdate ライフサイクルの二層

- ステータス: 採択
- 日付: 2026-08-01

## 背景

設立調査の「11 状態モデル」は、README ではリポジトリ単位の排他的状態のように読めた。しかし 11 状態は粒度が混在しており (`coverage_gap` は manifest、`update_open` / `blocked` は PR、`vulnerable_unpatched` / `sla_breached` は alert、`exception_active` は例外レコードの属性)、現実のリポジトリは複数の異常を同時に持つ。排他的状態に潰すと証跡が失われ、「証跡で説明する」という製品価値と矛盾する。2026-08-01 の設計レビューで構造を確定した。

## 決定

二層 + Evidence の構造を採る。

1. **Finding 分類法 (層 1)** — subject 別に共存する所見。`coverage_gap` (manifest)、`policy_drift` (bot 設定)、`paused_or_stalled` (bot 設定 / run)、`exception_active` (例外レコード)。
2. **ExpectedUpdate ライフサイクル (層 2)** — (repository, manifest, dependency) を同一性とする entity が `pending` → `update_open` → `blocked` (⇄) を経て、merge 後の再評価で `effective` / `merged_not_effective` に至る。分岐として `fix_unavailable` と `superseded`。PR と alert は entity に紐づく Evidence であり、entity 本体ではない。
3. **導出値** — `vulnerable_unpatched` と `sla_breached` は保存されず、advisory 参照付き ExpectedUpdate の未解決 (+ 期限超過) から導出する。`healthy` は Finding 不在かつ未解決 ExpectedUpdate 不在の導出結果。
4. **旧 11 状態表の再解釈** — 排他的状態機械ではなく、リポジトリ rollup の表示語彙 (worst-first + 件数併記、例外は抑止として作用) として存続する。

## 退けた代替案

- **(a) リポジトリ単位の排他的状態機械** — 共存する異常をどれか一つに潰し、証跡が失われる。また PR の merge で entity が終端するため、`merged_not_effective` (merge 後の再評価で発覚する) の置き場が構造的に無い。
- **(b) Finding 分類法のみ (ライフサイクルなし)** — `update_open` → `blocked` → `merged_not_effective` という「一つの更新が辿る物語」の遷移関係を表現できず、default branch 到達確認 (製品の中心差別化) の追跡が分断される。

## 帰結

- 保存されるのは Finding、ExpectedUpdate、Evidence。rollup と導出 Finding は常に計算結果であり、二重保存しない。
- 用語の詳細は CONTEXT.md が正。本 ADR は構造の選定理由のみを記録する。
- 「一リポジトリ一状態のほうが単純」という将来の再提案には、本 ADR の (a) の理由で応答すること。
