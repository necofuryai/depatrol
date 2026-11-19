# 0009. v0.2.0 以降、単一バンドル npm パッケージへ配布を一本化し build-once 原則を継承する

- ステータス: 採択（v0.2.0 で適用予定）
- 日付: 2026-11-19
- 置換対象: [ADR 0006](0006-distribution.md)、[ADR 0007](0007-build-once-immutable-release.md)（v0.1.x のリリース履歴および既存 baseline 検証は保持し、v0.2.0 以降の配布契約を本 ADR で置き換える）

## 背景

[ADR 0006](0006-distribution.md) と [ADR 0007](0007-build-once-immutable-release.md) は Go 単一バイナリを前提に、GoReleaser による 5 OS/arch アーカイブ、GitHub Releases、`go install`、および npm 6 パッケージ（メイン `depatrol` + プラットフォーム別 `@depatrol/cli-*` 5 個＋バイナリ解決シム）の build-once / immutable release 基盤を設計した。

[ADR 0008](0008-typescript-bun-stack.md) による TypeScript (Bun) 移行に伴い、プラットフォーム別ネイティブバイナリ再梱包と GoReleaser は不要になる。一方で、供給網を監査するツールとして ADR 0007 が確立した「署名付きタグ起点」「一度だけのビルドと attestation」「公開物のバイト一致検証」「lifecycle スクリプト禁止」の信頼境界は維持する必要がある。

## 決定

1. **配布形態の一本化**: `v0.2.0` 以降の正規配布物は、**Node.js 22+ / Bun の双方で動作する単一バンドル JS を同梱した単一 npm パッケージ `depatrol`** に一本化する。
   - Bun（`bun build --target=node` 等）により CLI エントリポイントをバンドルし、公開 `package.json` の実行時 `dependencies` は極小（原則ゼロ）とする。
   - **lifecycle スクリプト（`postinstall` 等）の禁止**を ADR 0006 から継承し、`npx depatrol`、`bunx depatrol`、`pnpm dlx depatrol`、`npm install --ignore-scripts` のすべてで動作する契約を維持する。
   - プラットフォーム別 npm パッケージ `@depatrol/cli-*`、バイナリ解決シム、GoReleaser、`go install`、および Homebrew cask 計画は `v0.2.0` で廃止する。
2. **build-once / immutable release 原則の継承（1 パッケージ向け簡素化）**:
   - リリース起点は `vMAJOR.MINOR.PATCH` と完全一致する **signed annotated SemVer tag** に限定し、登録済み公開鍵による署名検証、`main` 祖先チェック、release hardening baseline 検証を継承する。
   - `release-build` job で一度だけバンドル・単一 npm tarball（`depatrol-<version>.tgz`）・sha256 checksums・release notes・manifest を生成し、GitHub artifact attestation（`actions/attest`）を付与して固定名 Actions artifact（`overwrite: false`）として保存する。
   - **npm 公開**: 同一 Actions artifact から tarball を取得し、manifest・digest・attestation を検証した上で **OIDC Trusted Publishing** により単一パッケージ `depatrol` を公開する。同一 version が npm レジストリに既に存在する場合は、レジストリの SRI と今回 tarball がバイト一致するときのみ成功扱いとし、不一致なら停止して新 patch release を要求する。
   - **GitHub Releases**: 同一 Actions artifact から draft release を作成し、添付アセット（tarball・checksums）の一致確認後に publish し、repository-level **immutable releases** を継続適用する。
   - 部分失敗の修復は元 Actions artifact が残る 30 日以内の `Re-run failed jobs` に限定し、再ビルドの publish 混入を認めない。
3. **既存 `v0.1.x` 資産と `@depatrol/cli-*` の扱い**:
   - 公開済み `v0.1.0`〜`v0.1.6` の GitHub Releases と `.github/release-baselines.json` による定期整合性検証は破壊せず継続する。
   - `@depatrol/cli-*` は `v0.2.0` 以降の新規 publish を停止する（既存 `v0.1.x` 利用者のため旧版は残し、`v0.2.0` 公開後に必要に応じて deprecation 案内を付与する）。

## 理由

1. 5 OS/arch バイナリ＋6 npm パッケージ＋GoReleaser の構成を単一 `.tgz` へ縮約することで、リリース基盤の保守負荷と障害点を大幅に減らしつつ、ADR 0007 の供給網不変条件（build-once / attestation / SRI / immutable release）をそのまま守れる。
2. `optionalDependencies` を撤廃するため、古い npm lockfile 起因のプラットフォーム欠落（`npm/cli#4828`）が構造的に解消される。
3. `spawnSync` によるバイナリシムを介さず JS プロセスとして直接起動できるため、M1.5 の長寿命ローカル stdio MCP サーバー（`depatrol mcp`）における `SIGINT`/`SIGTERM` 処理や stdout 汚染防止が単純かつ確実になる。
4. 実行時依存をバンドル内へ閉じ込め公開 `dependencies` をゼロ（または極小）に保つことで、利用者環境での推移的パッケージ展開と供給網攻撃面を最小化できる。

## 退けた代替案

- **(a) `bun build --compile` でプラットフォーム別単一バイナリ配布を維持する**: ランタイム埋め込みでバイナリが 60〜100MB 級に肥大し、OS/libc 互換・再現ビルド・6 パッケージ保守コストがそのまま残る。
- **(b) 非バンドルの標準 ESM + 通常 npm `dependencies` で配布する**: ビルドは単純だが、供給網を監査するツール自身が多数の実行時 npm 依存ツリーを抱え込む。
- **(c) 署名タグ・attestation・immutable release を廃止して軽量 publish に戻す**: 既に確立した供給網セキュリティ上の強みを不要に後退させる。

## 帰結

- 実行環境要件は **Node.js 22+ または Bun** となる（`package.json` の `engines` に明記）。
- `packaging/npm/` の 6 パッケージ生成・シム、`scripts/release/` の GoReleaser 依存処理、`.goreleaser.yaml`、`docs/runbooks/release.md` は `v0.2.0` で単一 `.tgz` 前提へ刷新する。
- `release-integrity.yml` は `v0.1.x`（Go バイナリ baseline）と `v0.2.0+`（単一 tarball + immutable release）の双方を検証できるよう維持する。
- リリース関連ファイル（workflow、release scripts、署名鍵、hardening baseline）の保護と PR レビュー必須方針は ADR 0007 からそのまま継承する。
