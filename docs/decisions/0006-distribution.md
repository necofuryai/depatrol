# 0006. 配布はタグ起点とし、4 チャネルを段階導入する

- ステータス: 提案
- 日付: 2026-08-01

## 背景

ADR 0002 は「単一バイナリ配布が試しやすさに直結する」を Go 採択の筆頭理由とした。本 ADR はその配布を具体化する。検証戦略 (ROADMAP 並走レーン) は最小公開 → シグナル観測であり、配布チャネルの選定は試用までの摩擦の設計である。

想定利用者は Platform Engineering、AppSec、OSPO、開発基盤チーム (設立調査)。CLI は実行時に read-only の GITHUB_TOKEN を要求するため、どのチャネルでも試用摩擦がゼロになることはない。チャネル選定で削れるのはインストール摩擦であり、npx / bunx (ツールチェーン不要・単一コマンド) がその最小、go install は Go 環境保有者限定の作業ゼロ経路、Homebrew はインストールよりも更新導線として効く — という役割の差を前提に置く。

前提: 個人開発 OSS のため、有償サービス (GoReleaser Pro、Apple Developer Program) には依存しない。本 ADR の事実関係は 2026-08-01 に一次情報で検証した。手順・バージョン・チェックリスト等の運用詳細は docs/runbooks/release.md に置き、本 ADR は原則のみを記録する。

## 決定

1. **タグが release ID** — semver の git タグ (`v0.x.y`) をリリースの唯一の起点とし、push 済みタグは不変とする。最初のタグは最小公開 (M0 合格後) 時の `v0.1.0`。プレリリースタグは当面使わず、必要が生じた時点でチャネル別の伝播を決める。
2. **GitHub Releases が正規のビルド済み成果物** — GoReleaser OSS 版がタグ push でバイナリアーカイブ (darwin-arm64 / darwin-amd64 / linux-amd64 / linux-arm64 / windows-amd64、`CGO_ENABLED=0`) + sha256 checksums + changelog を生成する。他チャネルとの関係: **npm はこの成果物の再梱包**、**Homebrew はこの成果物への参照**、**go install は同一タグからの利用者側の独立ビルド**である。保証するのは「同一タグ由来」までで、「全チャネル同一バイナリ」は保証しない。
3. **チャネル公開は非原子的で、同一タグから冪等に修復する** — 成果物は正しいがチャネルへの反映に失敗した場合は、同一タグで該当チャネルの job を再実行して修復する。新しいパッチバージョンを切るのはソースまたは成果物そのものが変わる場合に限る。release workflow はチャネルごとに job を分離して権限を最小化し (Releases: contents write / npm: id-token write / tap: 専用 PAT)、action は full commit SHA に固定する。
4. **第 1 波 (v0.1.0、最小公開と同時)** — GitHub Releases、`go install github.com/necofuryai/depatrol@latest`、npm の 3 チャネル。
   - npm はメインパッケージ `depatrol` + プラットフォーム別パッケージ `@depatrol/cli-<os>-<arch>` (node 命名、`os` / `cpu` フィールド + optionalDependencies、同一バージョンに完全固定)。bin は Biome 式の実行時解決シム。**lifecycle スクリプト (postinstall) は使用禁止** — これが npx / bunx / pnpm dlx 互換の実体である。publish 順は platform パッケージ → メインパッケージ。
   - npm の初回 publish は granular token による手動 bootstrap でパッケージを作成し、その後 npmjs.com で trusted publisher (OIDC) を登録してトークンレス運用に移行する。trusted publishing の登録は既存パッケージの設定画面から行う構造のため、初回から適用はできない。
   - 名前確保のみ公開に先行する: パッケージ名 `depatrol` は空き確認済み (2026-08-01)。org `@depatrol` を取得し、不可なら `@necofuryai` スコープにフォールバックする。
5. **第 2 波 (トリガー到達後): Homebrew** — 自前 tap `necofuryai/homebrew-tap` + GoReleaser `homebrew_casks`。導入トリガーは「反復利用・brew 要望・組織導入シグナルのいずれかの観測」。導入時に quarantine の扱いを決める: 未署名 cask の post-install `xattr` hook は Homebrew 公式の Acceptable Casks 方針 (「Gatekeeper の無効化・回避を要求してはならない」) に反する構図であり、supply chain を監査する製品が採るならリスク受容の明記が必須。代替は Apple Developer Program での署名 (有償) で、組織導入シグナルが出た時点ではそちらが釣り合う可能性が高い。案内形式は公式文書どおり `brew install --cask necofuryai/tap/depatrol`。
6. **不採用** — GitHub Packages の npm レジストリ (public パッケージでも install にトークン必須)。ghcr.io は匿名 pull 可能で健全だが、コンテナが意味を持つ M4 で再検討する。scoop / winget / deb / rpm は需要シグナルが出るまで見送り。
7. **維持・撤退条件** — npm: 試用シグナルが npm 経由で観測されず、保守負荷 (6 パッケージ + シム) が価値を上回るなら deprecate し、Releases + go install に集約する。Homebrew: 導入後に同基準で判断する。homebrew-core は基準 (self-submission は 90 forks / 90 watchers / 225 stars のいずれか + リポジトリ作成から 30 日 + stable release) を満たした時点で申請し、tap は申請後も並存させる。

## 理由

1. タグ一本を release ID にすると、部分失敗の修復が「同一タグでチャネル job を再実行」に一元化され、publish の失敗でバージョン履歴が汚れない。
2. npm の方式選定は互換性で決まる。postinstall ダウンロード方式は、npm の `ignore-scripts` / v11 の allow-scripts 承認制、pnpm v10 のスクリプト遮断デフォルト、bun の default-secure (`trustedDependencies` 未登録のスクリプトを実行しない)、レジストリミラーのみ許可された CI、の 4 方向で壊れる。プラットフォーム別パッケージ方式はスクリプトゼロで全クライアントに通る (esbuild / Biome / turbo が収斂した現行標準)。
3. Homebrew を第 2 波に回すのは、(a) brew の価値は更新導線であり反復利用者の存在が前提、(b) quarantine の扱いという未決の信頼判断が残っており、その判断材料 (組織導入シグナルの有無) は公開後にしか得られない、(c) 製品価値の検証前に release engineering を完成させるのは検証戦略と逆順、の 3 点による。
4. homebrew-core への直行は notability 基準により現時点で不適格。tap は審査なしで core と並存可能なので、二段構えに機会損失はない。

## 退けた代替案

- **(a) GoReleaser Pro の `npms`** — 有償である上、公式自身が「technically a hack」「alpha」と明言する postinstall 方式で、理由 2 の互換性問題をそのまま持つ。
- **(b) postinstall で GitHub Releases からダウンロード** — 理由 2 のとおり。加えて取得物が npm の provenance / 署名検証の対象外になる。
- **(c) GitHub Packages (npm レジストリ)** — public でも install にトークン必須と公式 docs に明記。匿名インストールできないレジストリは公開配布に不適。
- **(d) 4 チャネルを最小公開と同時に揃える (本 ADR の旧案)** — npm 主導線の根拠に「利用者の中心が npm 圏」を挙げていたが、設立調査の想定利用者からは導出できず、CLI がトークン必須である以上「試用摩擦ゼロ」も成立しない。brew は更新導線であり最小公開時点では受益者が存在しないため、第 2 波に遅延しても検証を損なわない。製品価値の検証前に release engineering を完成させない。
- **(e) npm も第 2 波に遅延し、最小公開を Releases + go install のみにする** — ツールチェーン不要の npx / bunx というインストール摩擦最小の導線を最初の観測から外すと、「低摩擦の試用導線がシグナル量を左右する」という仮説自体を検証できない。npm は実験導線と位置づけ、撤退条件 (決定 7) を付けて第 1 波に残す。
- **(f) 初回から Apple Developer Program で署名** — 年会費が前提に反し、brew 導入前には受益者がいない。第 2 波の導入判断に組み込む (決定 5)。

## 帰結

- リポジトリの public 化が全チャネルの前提になる (Go module proxy の取得も homebrew-core の notability 指標の測定も公開が前提)。
- `--version` は ldflags 注入を優先し `debug.ReadBuildInfo().Main.Version` にフォールバックする二段構えで実装する。go install 経由でもタグ由来のバージョンが表示される。
- 管理する長期 credential は、npm bootstrap 用 granular token (初回のみ、用後失効) と、第 2 波以降の tap 用 fine-grained PAT に限る。
- 運用詳細 (workflow 構成と権限、action の SHA 固定、Node/npm 最低版、bootstrap 手順、既知の落とし穴、実機確認チェックリスト) は docs/runbooks/release.md に記録し、最小公開の準備で完成させる。
- Go module のメジャーバージョン運用 (v2 の `/v2` サフィックス問題) は v1 到達時に決める。v0 の間は実害がない。
