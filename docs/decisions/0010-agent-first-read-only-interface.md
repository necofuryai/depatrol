# 0010. AI エージェントを一次利用者とする read-only インターフェース設計

- ステータス: 採択（M1 以降で段階適用）
- 日付: 2026-11-19

## 背景

設立時点の depatrol は人間と CI を主な利用者とする CLI / ダッシュボードを想定していた。しかし実務では、Platform Engineering・AppSec・開発者がローカルのコーディングエージェント（Claude Code、Codex、Cursor 等）を用いて複数リポジトリの依存更新停滞をトリアージし、原因分析や改修 PR の草案作成を行うワークフローが広がっている。

一方、AI エージェントが GitHub API を場当たり的に叩いて依存更新の健全性を推測すると、① ページネーション漏れや 403 / rate-limit を「異常なし」と誤認する、② 直接観測と推定を混同して断定する、③ 対象リポジトリの PR / Issue 本文に含まれる非信頼テキストにより間接プロンプトインジェクション（XPIA）を受ける、という失敗が起きやすい。

depatrol が既に備える二層モデル・`Evidence`・`confirmed`/`inferred` 最弱リンク則・`ScanError` 分離（[ADR 0005](0005-two-layer-domain-model.md)）と read-only 原則（[ADR 0004](0004-governance-as-code.md)）は、AI エージェントの判断根拠エンジンとして強い差別化になる。

## 決定

1. **一次利用者と責務分界点**:
   - depatrol は **ローカルのコーディングエージェントを一次利用者とする決定論的な read-only 事実・証跡エンジン** としてインターフェースを設計する（将来的に定期・自律エージェントへ拡張）。
   - **depatrol 本体には LLM 呼び出しを組み込まない（恒久 Non-Goal）**。[ADR 0003](0003-no-version-resolution.md)（version 解決禁止）と [ADR 0004](0004-governance-as-code.md)（一切書き込まない）を厳守する。
   - エージェントが CI ログ深掘りや改修案作成へ接続しやすいよう、二層モデルを維持したまま PR 番号・URL・失敗チェック名・bot 種別などの**構造化ポインタ**を出力契約へ追加する（M1 / bot 中立モデル v1）。
2. **2 段階のインターフェース整備**:
   - **第 1 段（M1 / `v0.3.0`）— Agent-friendly CLI + 公式 `SKILL.md`**:
     - 出力の完全決定性（安定ソート・対象重複排除）、`schema_version` 付与と JSON Schema 公開、トークン膨張を抑える対象絞り込みフィルタ（`--only-unhealthy` 等）を整備する。
     - **Evidence を削るオプション（`--without-evidence` 等）は設けない**（[CONTEXT.md](../../CONTEXT.md) / ADR 0005 の原則とハルシネーション抑制価値を損なうため）。
     - 公式 `SKILL.md` を同梱・公開し、ドメイン語彙、`confirmed`/`inferred` 境界（`inferred` を自動修正や強制ゲートの単独根拠にしない）、`scan_errors` 必読（終了コード 0 でも `scan_errors` が入り得る）、非信頼文字列の扱いを明記する。
   - **第 2 段（M1.5 / M1 完了直後）— read-only ローカル stdio MCP (`depatrol mcp`)**:
     - 単一 npm パッケージ内のサブコマンド `depatrol mcp` として実装し、公式 TypeScript MCP SDK（`@modelcontextprotocol/sdk`）を利用する。
     - ツールは最小限の read-only 構成（`scan_repos`、`scan_org`、`get_repository_detail`）＋ドメイン語彙・JSON Schema を提供する Resource とする。全ツールに `readOnlyHint: true`、`destructiveHint: false`、`idempotentHint: true` を設定する。
     - 対話トリアージ中の再走査レイテンシを抑えるため、**MCP プロセス内限定のインメモリキャッシュ**（明示 `refresh` 指定可）と `notifications/progress` 進捗通知を備える。ディスク永続化は持たず、M0〜M2 のステートレス CLI 原則と両立させる。
     - Rollup 要約のみで `scan_errors` や `inferred` が隠蔽されないよう、すべての走査応答に `scan_errors` 全件と確度情報を明示する。
3. **セキュリティ境界（間接プロンプトインジェクション / XPIA 防御）**:
   - スキャン対象リポジトリ由来の自由テキスト（PR 本文、Issue 本文、レビュー本文、CI ログ）は**出力に生転載しない**。M1 の Renovate Dependency Dashboard や grouped PR 解析もパーサ境界で構造化値のみ抽出し、曖昧な紐付けは最弱リンク則に従い `inferred` とする。
   - 出力に含める外部由来文字列（check run 名、ファイルパス、依存名、エラー文等）には制御文字除去と長さ上限を適用する。
   - 改修実行（PR 作成・設定修正・マージ等）は depatrol のスコープ外とし、利用者側エージェントによる人間承認（HITL）前提の操作に委ねる。

## 理由

1. ローカルコーディングエージェントの多くは CLI + JSON + `SKILL.md` で常駐ツール定義のコンテキスト負荷なく運用でき、同じ JSON 契約・フィルタ改善が人間と CI 利用者にも還元される。
2. M1（bot 中立モデル v1）を先に確定してから `depatrol mcp` を追加することで、Dependabot 専用スキーマの早期固定やツール契約の作り直しを避けられる。
3. MCP プロセス内インメモリキャッシュにより、M3 の観測キャッシュ DB を前倒しせずに対話セッション内の深掘り応答性を確保できる。
4. depatrol 自身が決定論的かつ read-only であり続けることで、録画 HTTP カセットによる完全回帰検証・LLM API キー不要・最小権限 PAT 運用を両立できる。

## 退けた代替案

- **(a) depatrol 本体へ LLM 呼び出しを組み込む**: 決定論性・録画カセット検証・最弱リンク則を破壊し、API キー管理とデータ外部送信の導入障壁を生む。
- **(b) Write 系 MCP ツールを提供する**: [ADR 0004](0004-governance-as-code.md) の「侵害されても何も書き換えられない」信頼境界を破壊する。
- **(c) M0〜M2 段階でリモート HTTP MCP サーバーを構築する**: OAuth / 認可 / マルチテナント運用が先行し、ローカルエージェント中心の検証段階に対して過剰である。
- **(d) `--without-evidence` オプションで出力を圧縮する**: 証跡による説明とハルシネーション抑制という中核価値を自ら損なう。
- **(e) M1 時点で SQLite ディスクキャッシュを前倒し導入する**: Node 22+ / Bun 両互換と永続化設計を前倒しで抱える割に、対話セッション用途はインメモリキャッシュで充足できる。

## 帰結

- `v0.2.0` は既存 20 カセットとの 1:1 出力一致を優先する純粋移植に徹し、本 ADR のスキーマ拡張・`SKILL.md` は M1（`v0.3.0`）、`depatrol mcp` は M1.5 で順次実装する。
- M1 + `depatrol mcp` 出荷後に需要・実運用検証ゲートを置き、実利用シグナルを見て M2（到達検証一般化・scanner adapter）と M3（Governance-as-Code・観測キャッシュ DB・定期自律エージェント連携）の優先順を決定する。
- 閲覧専用 Web UI（旧 M4）は、エージェント＋構造化出力では満たせない需要シグナルが確認されるまで凍結する。
