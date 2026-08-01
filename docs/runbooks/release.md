# Release runbook (draft)

ADR 0006 の運用詳細。原則は ADR 0006 が正で、本書は手順・バージョン・チェックリストのみを持つ。最小公開 (M0 合格後) の準備で完成させる。事実関係は 2026-08-01 に一次情報で検証したもの。

## パイプライン成立条件

- GoReleaser OSS v2 (検証時 v2.17.1) + goreleaser/goreleaser-action (検証時 v7.2.3)。release workflow 内のすべての action は full commit SHA に固定する (可動タグ `@v7` は使わない)。
- actions/checkout は `fetch-depth: 0` (changelog 生成に全履歴が必要)。actions/setup-go を併用する。
- job 分離と権限 (ADR 0006 決定 3):
  - build + GitHub Releases job: `contents: write`
  - npm job: `id-token: write` + Node.js 22.14+ / npm 11.5.1+ のセットアップ
  - tap job (第 2 波): fine-grained PAT (homebrew-tap リポジトリ限定、Contents: Read and write) を Actions secrets で管理。PAT は有効期限で静かに失効するため、失効時は再発行して同一タグで job を再実行する
- version stamping: GoReleaser デフォルト ldflags (`-X main.version={{.Version}}` 等) に合わせて main パッケージに version / commit / date 変数を置き、未注入時は `debug.ReadBuildInfo().Main.Version` にフォールバックする。

## npm

- パッケージ構成: `depatrol` (bin = Biome 式実行時解決シム: require.resolve + spawnSync、環境変数でのバイナリパス上書きを用意) + `@depatrol/cli-{darwin-arm64,darwin-x64,linux-x64,linux-arm64,win32-x64}` (各 package.json に `os` / `cpu` を宣言、バイナリのみ同梱)。optionalDependencies は同一バージョンに完全固定。publish 順は platform → メイン。
- 初回 bootstrap: granular token で 6 パッケージを手動 publish → npmjs.com の各パッケージ設定で trusted publisher (リポジトリ + workflow ファイル名) を登録 → token を失効させる。以後は OIDC で publish (公開リポジトリなら provenance 自動付与)。package.json の `repository` フィールドは実リポジトリと大文字小文字まで厳密一致させる。
- CGO_ENABLED=0 のため musl 変種 (`-musl` パッケージ) は持たない。
- 既知の落とし穴: 旧 npm が生成した lockfile から他プラットフォームの optional 依存が抜ける npm/cli#4828 (修正済みだが古い lockfile で再現しうる)。README に「`npm ci` が `Cannot find module @depatrol/...` で失敗したら lockfile を再生成」を記載する。

## Homebrew (第 2 波、トリガー到達後)

- tap リポジトリ `necofuryai/homebrew-tap` を作成し、GoReleaser `homebrew_casks` で自動 push する (旧 `brews` は v2.16 で deprecated)。
- 導入時判断 (ADR 0006 決定 5): 未署名 cask の quarantine を post-install `xattr -dr com.apple.quarantine` hook で除去する (Gatekeeper バイパス — リスク受容の明記が前提) か、Apple Developer Program で署名・notarization するか。
- homebrew-core: self-submission は 90 forks / 90 watchers / 225 stars のいずれか + リポジトリ作成から 30 日 + stable release が条件。充足したら申請し、tap は並存させる。
- 実機確認 (導入時): `brew install --cask necofuryai/tap/depatrol` が Tap Trust 込みで 1 コマンドで完結すること、`brew upgrade` で cask が更新されること、fine-grained PAT で tap への push が通ること (403 なら classic PAT の repo スコープにフォールバック)。

## 検証チェックリスト (第 1 波、v0.1.0)

- [ ] タグ push で Releases に 5 ターゲットのアーカイブ + sha256 checksums + changelog が揃う
- [ ] `go install github.com/necofuryai/depatrol@v0.1.0` が成功し、`--version` がタグ由来のバージョンを表示する
- [ ] `npx depatrol --version` / `bunx depatrol --version` / `pnpm dlx depatrol --version` が macOS / Linux / Windows で動く
- [ ] `npm install --ignore-scripts` でも動作する (lifecycle スクリプト非依存の確認)
- [ ] npm パッケージに provenance が付与されている (`npm audit signatures` で確認)
- [ ] publish 部分失敗 → 同一タグでの該当 job 再実行が冪等に修復する (published 済みパッケージをスキップして続行できる)
