# Release runbook

ADR 0006 の運用詳細。原則は ADR 0006 が正で、本書は手順・バージョン・チェックリストのみを持つ。事実関係は 2026-08-01 に一次情報で検証し、同日の最小公開準備で本書を確定した。

## パイプライン構成 (実装済み)

- GoReleaser OSS v2.17.1 ([release.yml](../../.github/workflows/release.yml) が `version: v2.17.1` で固定) + goreleaser/goreleaser-action。設定は [.goreleaser.yaml](../../.goreleaser.yaml)。ldflags はデフォルトのまま使い、[main.go](../../main.go) 側の変数名を合わせる。
- release workflow 内のすべての action は full commit SHA に固定する (可動タグは使わない)。現在の固定値:

  | action | tag | commit SHA |
  |---|---|---|
  | actions/checkout | v7.0.1 | `3d3c42e5aac5ba805825da76410c181273ba90b1` |
  | actions/setup-go | v7.0.0 | `b7ad1dad31e06c5925ef5d2fc7ad053ef454303e` |
  | actions/setup-node | v7.0.0 | `820762786026740c76f36085b0efc47a31fe5020` |
  | goreleaser/goreleaser-action | v7.2.3 | `f06c13b6b1a9625abc9e6e439d9c05a8f2190e94` |

- actions/checkout は `fetch-depth: 0` (changelog 生成に全履歴が必要)。
- job 分離と権限 (ADR 0006 決定 3):
  - github-release job: `contents: write`
  - npm job: `contents: read` (Releases からのダウンロード) + `id-token: write` (OIDC)。Node 24 + npm 11 を使い、publish.mjs が OIDC 最低要件の npm 11.5.1+ を assert する。
  - tap job (第 2 波): fine-grained PAT (homebrew-tap リポジトリ限定、Contents: Read and write) を Actions secrets で管理。PAT は有効期限で静かに失効するため、失効時は再発行して同一タグで job を再実行する。
- version stamping: GoReleaser デフォルト ldflags (`-X main.version={{.Version}}` 等) に合わせて main パッケージに version / commit / date 変数を置き、未注入時は `debug.ReadBuildInfo().Main.Version` にフォールバックする (実装済み)。
- npm 再梱包: npm job が Releases のアーカイブを sha256 checksums 検証つきでダウンロードし、[packaging/npm/prepare.mjs](../../packaging/npm/prepare.mjs) が 6 パッケージに staging、[packaging/npm/publish.mjs](../../packaging/npm/publish.mjs) が publish する。publish は `npm view` で published 済みバージョンをスキップする冪等動作で、順序は platform → メイン。

## npm

- パッケージ構成: `depatrol` (bin = Biome 式実行時解決シム: require.resolve + spawnSync、`DEPATROL_BINARY` でのバイナリパス上書きあり) + `@depatrol/cli-{darwin-arm64,darwin-x64,linux-x64,linux-arm64,win32-x64}` (各 package.json に `os` / `cpu` を宣言、バイナリのみ同梱)。optionalDependencies は同一バージョンに完全固定。lifecycle スクリプトは使用しない。
- `package.json` の `repository` フィールドは実リポジトリと大文字小文字まで厳密一致させる (provenance 検証の条件)。
- CGO_ENABLED=0 のため musl 変種 (`-musl` パッケージ) は持たない。
- 既知の落とし穴: 旧 npm が生成した lockfile から他プラットフォームの optional 依存が抜ける npm/cli#4828 (修正済みだが古い lockfile で再現しうる)。README・npm README に「`npm ci` が `Cannot find module @depatrol/...` で失敗したら lockfile を再生成」を記載済み。シムのエラーメッセージも同じ案内を出す。

### 初回 bootstrap (stub 方式)

trusted publisher の登録は既存パッケージの設定画面からしか行えず、granular token による手動 publish には provenance が付かない。v0.1.0 を token で publish すると検証チェックリスト「v0.1.0 に provenance」が満たせないため、**中身のない stub バージョンで先にパッケージ名だけを作り、v0.1.0 本体は最初から OIDC で publish する**:

0. 前提: npm org `depatrol` が存在すること (2026-08-01 取得済み)。scoped パッケージの publish には username か既存 org のスコープが必須で、org 名が取れない場合のフォールバックは `@necofuryai` スコープ (ADR 0006 決定 4)。フォールバック時は packaging/npm/ 内の `@depatrol` 参照 3 箇所 (メイン package.json の optionalDependencies、シムの PLATFORMS、prepare.mjs) を改名してから publish する。
1. npmjs.com で granular token を作成する: Packages and scopes は **Read and write / All packages** (未作成の unscoped `depatrol` は個別指定できない)、**Bypass two-factor authentication を有効化**、有効期限は最短。アカウントの publishing access は既定で「2FA または bypass 付き granular token」を要求するため、bypass 無しの token は publish 時に E403 になる (2026-08-01 実地確認)。`npm login` セッションは publish 時に 2FA の対話を要するため token 方式を推奨。
2. `node packaging/npm/prepare.mjs 0.0.0-bootstrap --stub`
3. `node packaging/npm/publish.mjs packaging/npm/dist --tag bootstrap` — 注意: `--tag bootstrap` を付けても、パッケージの初回 publish には npm の仕様で `latest` も同時に付く (2026-08-01 実地確認)。実害はなく、v0.1.0 の publish で `latest` は自動的に移る。
4. npmjs.com で 6 パッケージそれぞれの Settings → Trusted Publisher に GitHub Actions を登録する: Organization or user `necofuryai` / Repository `depatrol` / Workflow filename `release.yml` (ファイル名のみ) / Environment name 空欄 / **Allowed actions は「Allow npm publish」をチェック** (少なくとも 1 つ必須で、未選択のままでは保存できない — 2026-08-01 実地確認)。保存後、セクションが「Select your publisher」から設定内容の要約表示に変わることを確認する。
5. granular token を失効させる。以後の長期 credential はゼロ。
6. v0.1.0 の npm job を (再) 実行する → OIDC + provenance で publish される (公開リポジトリなら provenance は自動付与)。
7. publish 確認後、6 パッケージの Publishing access を「Require two-factor authentication and disallow bypass 2fa tokens」に切り替える (trusted publisher の動作には影響しない)。bypass token による direct publishing は npm 側でも 2027-01 に廃止予定。
8. 任意: `npm deprecate depatrol@0.0.0-bootstrap "bootstrap placeholder; install latest"` (5 platform パッケージも同様)。

## 最小公開手順 (v0.1.0)

1. main で ci.yml が green であること。
2. 公開前 secret スキャン: git 全履歴と `internal/cli/testdata/cassettes/` (録画時の Authorization ヘッダ) に credential が無いことを確認する。
3. `gh repo edit necofuryai/depatrol --visibility public --accept-visibility-change-consequences`
4. `git tag v0.1.0 && git push origin v0.1.0`
5. github-release job の成果物 (5 アーカイブ + checksums + changelog) を確認する。
6. npm bootstrap (上記) → 同一タグで npm job を再実行する。
7. branch protection を設定する (required check = ci / test、PR 必須)。以後 main への直接 commit をやめ、短命ブランチ + PR に統一する (CLAUDE.md のブランチ戦略)。
8. 検証チェックリストを消化する。

チャネル公開は非原子的である (ADR 0006 決定 3)。タグ push 時点で bootstrap 未了なら npm job は失敗するが、これは想定内で、bootstrap + trusted publisher 登録後に同一タグで npm job を rerun して修復する — この rerun がチェックリスト最終項目 (冪等修復) の実地検証を兼ねる。

再実行の冪等性は `.goreleaser.yaml` の `release.replace_existing_artifacts: true` が支える (未設定だと公開済みリリースへの asset 再アップロードが 422 で恒久失敗し、npm job も `needs` 経由でスキップされる)。github-release job がアップロード途中で失敗した場合は未公開 draft が Releases に残ることがあるので、削除してから再実行する。

## Homebrew (第 2 波、トリガー到達後)

- tap リポジトリ `necofuryai/homebrew-tap` を作成し、GoReleaser `homebrew_casks` で自動 push する (旧 `brews` は v2.16 で deprecated)。
- 導入時判断 (ADR 0006 決定 5): 未署名 cask の quarantine を post-install `xattr -dr com.apple.quarantine` hook で除去する (Gatekeeper バイパス — リスク受容の明記が前提) か、Apple Developer Program で署名・notarization するか。
- homebrew-core: self-submission は 90 forks / 90 watchers / 225 stars のいずれか + リポジトリ作成から 30 日 + stable release が条件。充足したら申請し、tap は並存させる。
- 実機確認 (導入時): `brew install --cask necofuryai/tap/depatrol` が Tap Trust 込みで 1 コマンドで完結すること、`brew upgrade` で cask が更新されること、fine-grained PAT で tap への push が通ること (403 なら classic PAT の repo スコープにフォールバック)。

## 検証チェックリスト (第 1 波、v0.1.0)

- [x] タグ push で Releases に 5 ターゲットのアーカイブ + sha256 checksums + changelog が揃う (2026-08-01 確認)
- [x] `go install github.com/necofuryai/depatrol@v0.1.0` が成功し、`--version` がタグ由来のバージョンを表示する (2026-08-01 確認)
- [ ] `npx depatrol --version` / `bunx depatrol --version` / `pnpm dlx depatrol --version` が macOS / Linux / Windows で動く (macOS は 3 ランナーとも 2026-08-01 確認済み。Linux / Windows は未確認)
- [x] `npm install --ignore-scripts` でも動作する (2026-08-01 実レジストリで確認)
- [x] npm パッケージに provenance が付与されている (`npm audit signatures` で verified attestations を 2026-08-01 確認)
- [x] publish 部分失敗 → 同一タグでの該当 job 再実行が冪等に修復する (2026-08-01 実証: ENEEDAUTH 失敗 → bootstrap 後の rerun で publish 成功、さらに全 job 再実行で npm 全 skip + Releases asset 置換を確認)
