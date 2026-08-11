# 依存関係自動更新の導入調査

- 調査基準日：2026-08-10
- 対象リポジトリ：`necofuryai/depatrol`
- 読者：リポジトリ管理者とリリース担当者
- 調査範囲：GitHub Dependabot、Mend-hosted Renovate、GitHub Dependency Review、Go vulnerability management、GitHub Actions と npm trusted publishing
- 改訂理由：Forking Renovate 固有の継続性リスクを避け、現役の npm OSS における運用実態を反映する
- 実装状況：repository 内の設定、workflow、検証 script、ADR、runbook は 2026-08-10 に実装済み。外部設定は repository 外の状態であり、runbook に従って live state を確認する

## 実装結果

調査結果を [renovate.json](../../renovate.json)、[CI workflow](../../.github/workflows/ci.yml)、[release workflow](../../.github/workflows/release.yml) に反映した。

Release integrity の変更は [ADR 0007](../decisions/0007-build-once-immutable-release.md)、運用手順は [release runbook](../runbooks/release.md)、dependency update の運用は [dependency update runbook](../runbooks/dependency-updates.md) に記録した。

Go toolchain は 2026-08-10 時点の最新 stable `1.26.5` を使う。
Renovate は Go の更新を平日に確認し、release から 1 日後に Pull Request を作成するが、automerge はしない。

Local では Renovate strict validator と manager extraction、root と tools の module integrity、build、vet、format、race test、`govulncheck`、`actionlint`、release script の unit test を通過した。

GitHub ruleset、Dependency graph、Dependabot alerts、immutable releases、Actions policy、`npm-release` environment、npm trusted publisher、Mend Renovate App は external write であるため、この repository 内の実装だけでは完了しない。

この実装は depatrol 自身の dependency automation であり、製品機能 M1 の Renovate scanner adapter を実装するものではない。

最初の 2 Renovate cycle、最初の実脆弱性修正、次の実 release、npm job の実 retry は将来イベントに依存する観察項目であり、実装時点の acceptance には含めない。

## 結論

`depatrol` では、通常更新と脆弱性修正の Pull Request 作成を標準 Mend Renovate App に一本化する。

GitHub の Dependency graph と Dependabot alerts は脆弱性情報源として有効化するが、Dependabot version updates と Dependabot security updates は無効のままにする。

Pull Request には GitHub Dependency Review、強化した `test`、publish しない `release-preflight` を必須とし、Go の到達可能な脆弱性を補うため `govulncheck` を `test` job に追加する。

初期導入では Renovate の automerge をすべて無効にし、すべての Renovate Pull Request に maintainer 一名の承認を要求する。

Forking Renovate は採用しない。

標準 App は Vite、Vitest、Prettier、ESLint、typescript-eslint、Babel で現役利用を確認でき、Forking 版固有の hosted service には依存しない。

標準 Mend-hosted service への実行時依存は残るが、Renovate OSS 本体と repository 内の `renovate.json` の大部分は self-host でも再利用できる。

標準 App は target repository の Contents と Workflows に write permission を持つため、利便性だけを理由に無条件で導入してはならない。

導入前に `main` と `v*` tag を ruleset で保護し、Renovate App を bypass actor に含めず、Pull Request workflow から release credential と OIDC publish 権限を分離することを採用条件にする。

依存関係 bot を導入する前に、`v*` tag の作成者制限と更新・削除禁止、GitHub immutable releases、および release workflow の exact SemVer、署名済み annotated tag、`main` 祖先の検証を実装する。

immutable releases に合わせて公開済み GitHub Release asset の同一 tag 置換を廃止し、誤った公開物は新しい patch version で修正する。

immutable releases は有効化後の future release にだけ適用されるため、既存の `v0.1.0` と `v0.1.1` は mutable のまま残る。

標準 App の Contents write が既存 release に届く残余リスクを許容できない場合は、機能範囲を狭めて Dependabot-only を選ぶ。

この順序なら、Renovate が target repository 内に branch を作成しても、maintainer が Pull Request を承認して merge しただけでは npm publish に到達せず、制限された release tag の作成だけが公開操作になる。

正しい release 順序は `Pull Request を main へ merge → main の required checks 成功 → その commit に signed annotated SemVer tag を作成 → tag push` であり、merge 前に tag を push してはならない。

この自動 tag-triggered release を維持する代わりに、tag creation を許可された repository administrator は release trust boundary として扱う。

この構成では Renovate 用の Fork は作られず、同時に存在する `renovate/*` branch と Pull Request は `prConcurrentLimit` で上限を設ける。

[Renovate の `pruneStaleBranches`](https://docs.renovatebot.com/configuration-options/#prunestalebranches) は既定で有効であり、merge、close、不要化した未改変 branch は次回実行で削除するが、人が commit を追加した branch は削除せず abandoned として残す。

## 判断の前提

### 調査開始時点に確認したリポジトリ状態

- default branch は `main` であり、legacy branch protection は `test` を required check として strict mode で要求し、administrator にも適用している。
- GitHub ruleset は未作成であり、release tag の作成、更新、削除を制限する tag ruleset は存在しない。
- GitHub immutable releases は無効である。
- Dependabot alerts は無効であり、Dependabot security updates も無効である。
- Dependabot version updates の設定ファイルは存在せず、dependency bot が作成した Pull Request も存在しない。
- GitHub Actions はすべての action を許可し、repository setting の full-SHA pinning requirement は無効である。
- workflow 内の action はすでに full commit SHA へ固定されているが、この規約は repository setting では強制されていない。
- 既存の `v0.1.0` と `v0.1.1` は annotated tag で、GitHub Git tags API の `verification.verified` はどちらも `true` であるが、この運用は ruleset や workflow で強制されていない。
- 実装前の [`docs/runbooks/release.md`](../runbooks/release.md) は lightweight tag を案内しており、実際の signed annotated tag と手順が一致していなかった。
- [`go.mod`](../../go.mod) は Go toolchain と Go module を管理し、JavaScript の runtime dependency は持たない。
- [`packaging/npm/depatrol/package.json`](../../packaging/npm/depatrol/package.json) は release 時に展開する version `0.0.0-managed` のテンプレートであり、通常の npm manifest として更新してはならない。
- [`CONTRIBUTING.md`](../../CONTRIBUTING.md) は DCO sign-off と scope を付けない `<type>: <description>` 形式を要求している。

上記の GitHub 設定は 2026-08-10 に GitHub REST API と GraphQL API で確認した時点の値である。

### 調査開始時点の release workflow に固有だった危険

実装前の [`release.yml`](../../.github/workflows/release.yml) は `v*` に一致する任意の tag push を release trigger とし、exact SemVer、tag signature、`main` への到達を検証していなかった。

実装前の [`.goreleaser.yaml`](../../.goreleaser.yaml) は同一 release の asset を再実行時に置換できるよう `replace_existing_artifacts: true` を指定していた。

実装前の [`publish.mjs`](../../packaging/npm/publish.mjs) は npm 上に同じ version が存在すれば publish を skip し、registry SRI を確認していなかった。

したがって、公開済み tag が別 commit へ移動または再作成されるか、Contents write を持つ actor が同一 release の asset を置換すると、GitHub Release の asset だけが新しい内容へ変わり、npm の同じ version は古い内容のまま残る可能性がある。

この GitHub と npm の不一致は実装開始時点の構成から導く推論であり、tag ruleset と immutable releases の両方を必須にする理由である。

## 候補の比較

| 機能 | 担当できること | このリポジトリでの判断 |
|---|---|---|
| [Dependabot alerts](https://docs.github.com/en/code-security/concepts/supply-chain-security/dependabot-alerts) | Dependency graph と GitHub Advisory Database を基に default branch の既知脆弱性を通知する | 有効化し、脆弱性の情報源として使う |
| [Dependabot security updates](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/configure-security-updates) | alert に対して安全な version への Pull Request を作成する | Renovate と PR 作成権限が重複するため無効にする |
| [Dependabot version updates](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/configure-version-updates) | `dependabot.yml` の ecosystem と schedule に従って通常更新 Pull Request を作成する | Renovate と PR 作成権限が重複するため導入しない |
| [標準 Mend Renovate App](https://docs.renovatebot.com/modules/platform/github/) | hosted service が広い manager と datasource を使って target repository 内に branch と Pull Request を作成する | ruleset と human approval を先に整備する条件で採用する |
| [Forking Renovate App](https://docs.renovatebot.com/getting-started/running/#forking-renovate-app) | public repository の code を read-only で読み、Fork から Pull Request を作成する | 権限は小さいが提供形態が限定的で、継続性を優先して採用しない |
| [Renovate self-hosting](https://docs.renovatebot.com/getting-started/running/#self-hosting-renovate) | 実行環境、credential、schedule、Renovate 自体の更新を管理者が制御する | hosted service 終了時の移行先として残すが、初期導入では運用負荷に見合わない |
| [Dependency Review](https://docs.github.com/en/code-security/concepts/supply-chain-security/dependency-review) | Pull Request が導入する dependency 差分を調べ、既知脆弱性を含む変更を merge 前に失敗させる | updater と役割が重ならない merge gate として採用する |
| [`govulncheck`](https://go.dev/doc/security/vuln/) | Go source と call graph を使い、利用中の module にある脆弱な function の到達可能性を絞り込む | manifest 差分だけでは得られない Go 固有の実行可能性情報として採用する |

[GitHub の quickstart](https://docs.github.com/en/code-security/tutorials/secure-your-dependencies/dependabot-quickstart) は Dependabot alerts、security updates、version updates を別機能として説明しているため、alerts だけを有効にする構成は仕様に沿っている。

[Renovate の `vulnerabilityAlerts`](https://docs.renovatebot.com/configuration-options/#vulnerabilityalerts) は GitHub Dependabot alerts を読み、通常の schedule、rate limit、minimum release age を待たずに修正 Pull Request を作成する。

そのため、Dependabot security updates と Renovate `vulnerabilityAlerts` を同時に有効化せず、security fix の PR 作成者も Renovate 一つに限定する。

[Renovate の公式 GitHub platform documentation](https://docs.renovatebot.com/modules/platform/github/) は、GitHub Cloud の大半の利用者に標準 Mend Renovate App を推奨し、Mend が token の保管と Renovate version の更新を担当すると説明している。

[Renovate の security and permissions](https://docs.renovatebot.com/security-and-permissions/) によれば、標準 App は Code、Workflows、Checks、Commit statuses、Issues、Pull Requests に read and write permission を持ち、Administration、Dependabot alerts、Metadata に read permission を持つ。

Code と Workflows の write は GoReleaser の `with.version` と GitHub Actions の full SHA を更新するために必要だが、Checks と Commit statuses の write は dependency file 更新そのものには不要な追加権限である。

標準 App は ref と GitHub Release の変更、status の投稿、ruleset を満たした Pull Request の merge に届くため、tag ruleset、expected check source、human approval を採用前の必須条件にする。

### 継続性の評価

2026-08-10 時点で [`renovatebot/renovate`](https://github.com/renovatebot/renovate) は archived ではなく、22,216 stars、3,230 forks で、同日に [44.17.3](https://github.com/renovatebot/renovate/releases/tag/44.17.3) が公開されていた。

同日時点で [`dependabot/dependabot-core`](https://github.com/dependabot/dependabot-core) も archived ではなく、2026-08-03 に [v0.390.0](https://github.com/dependabot/dependabot-core/releases/tag/v0.390.0) が公開されていた。

これらの値は将来の提供継続を保証しないが、Renovate と Dependabot の engine 自体はどちらも活発であり、Forking Renovate の日本語情報量だけを Renovate 全体の採用状況と同一視すべきではない。

[Renovate の configuration model](https://docs.renovatebot.com/config-overview/) は repository config と self-hosted の bot config を分離している。

今回の `renovate.json` に Mend-hosted 固有の secret や Merge Confidence 依存を入れなければ、標準 App の提供終了時にも repository policy の大部分を再利用して self-hosted Renovate へ移行できる。

移行時に追加で必要になるのは GitHub App または token、実行 schedule、Renovate container の version 管理、log、cache、runtime isolation である。

bot identity、global config、closed Pull Request history、既存 branch、schedule、cache は自動移行されないため、これは設定先の切り替えだけでは完了しない。

即時の縮退策は Renovate App を停止して Dependabot の `gomod` と `github-actions` を有効化し、GoReleaser、Node.js、npm CLI の version を一時的に手動管理することである。

## npm OSS の現行運用調査

2026-08-10 に、npm registry で公開中の package と GitHub repository の対応を確認し、default branch の updater 設定、最近の bot Pull Request、release workflow を調べた。

この標本は著名で活発な project を意図的に選んだものであり、市場シェアを推定する無作為標本ではない。

| Project と npm package | 依存更新の確認結果 | release 境界または運用上の特徴 |
|---|---|---|
| [Vite](https://github.com/vitejs/vite/tree/6452703914bb44e4f428864f15dac7df8e31c9b9) / `vite` | [Renovate config](https://github.com/vitejs/vite/blob/6452703914bb44e4f428864f15dac7df8e31c9b9/.github/renovate.json5) と同一 repository 内 branch の [PR #23217](https://github.com/vitejs/vite/pull/23217) | weekly、non-major group、npm release age、Action digest pinningを使い、[tag-triggered publish](https://github.com/vitejs/vite/blob/6452703914bb44e4f428864f15dac7df8e31c9b9/.github/workflows/publish.yml) は `Release` environment と OIDC を使う |
| [Vitest](https://github.com/vitest-dev/vitest/tree/3cf27ed99eeffdf40d286e57a0c6693e7008f1a0) / `vitest` | [Renovate config](https://github.com/vitest-dev/vitest/blob/3cf27ed99eeffdf40d286e57a0c6693e7008f1a0/.github/renovate.json5) と同一 repository 内 branch の [PR #10898](https://github.com/vitest-dev/vitest/pull/10898) | weekly、non-major group、1 day の release age を使い、[publish workflow](https://github.com/vitest-dev/vitest/blob/3cf27ed99eeffdf40d286e57a0c6693e7008f1a0/.github/workflows/publish.yml) は release commit を検出して `Release` environment と OIDC を使う |
| [Prettier](https://github.com/prettier/prettier/tree/903845c7d16ce66dedd9d5ab4b858d233f48341a) / `prettier` | [Renovate config](https://github.com/prettier/prettier/blob/903845c7d16ce66dedd9d5ab4b858d233f48341a/.github/renovate.json5) と同一 repository 内 branch の [PR #19823](https://github.com/prettier/prettier/pull/19823) | Dashboard approval、grouping、Action digest pinning を使い、Dependabot security PR も観測した |
| [ESLint](https://github.com/eslint/eslint/tree/585ef37516c0dc29ddb91ce2a2cdcc46fdbbd610) / `eslint` | [Renovate](https://github.com/eslint/eslint/blob/585ef37516c0dc29ddb91ce2a2cdcc46fdbbd610/.github/renovate.json5) と [Dependabot](https://github.com/eslint/eslint/blob/585ef37516c0dc29ddb91ce2a2cdcc46fdbbd610/.github/dependabot.yml) の両方が GitHub Actions を対象にし、[Renovate PR #21196](https://github.com/eslint/eslint/pull/21196) と [Dependabot PR #21199](https://github.com/eslint/eslint/pull/21199) が同じ CodeQL Action を連続して更新した | 二つの PR producer で scope が重複した実例であり、`depatrol` では二系統にしない |
| [typescript-eslint](https://github.com/typescript-eslint/typescript-eslint/tree/f853ef9c6eb1ccdb80dcaaa2e8ca100cddcfa0ac) / `@typescript-eslint/parser` | [Renovate config](https://github.com/typescript-eslint/typescript-eslint/blob/f853ef9c6eb1ccdb80dcaaa2e8ca100cddcfa0ac/.github/renovate.json5) と同一 repository 内 branch の [PR #12672](https://github.com/typescript-eslint/typescript-eslint/pull/12672) | major approval、7 days の release age、grouping を使い、[release workflow](https://github.com/typescript-eslint/typescript-eslint/blob/f853ef9c6eb1ccdb80dcaaa2e8ca100cddcfa0ac/.github/workflows/release.yml) は npm environment と OIDC を使う |
| [Babel](https://github.com/babel/babel/tree/1eac4481473df52fbbcb452c4dca8d79039dbb63) / `@babel/core` | [Renovate config](https://github.com/babel/babel/blob/1eac4481473df52fbbcb452c4dca8d79039dbb63/renovate.json) と同一 repository 内 branch の [security PR #17832](https://github.com/babel/babel/pull/17832) | Dashboard approval、custom regex、post-upgrade task を使い、[tag-triggered release](https://github.com/babel/babel/blob/1eac4481473df52fbbcb452c4dca8d79039dbb63/.github/workflows/release.yml) は npm environment と OIDC を使う |
| [pnpm](https://github.com/pnpm/pnpm/tree/9463e98c1eebc78a893c251f25a13393a1410020) / `pnpm` | 現行 [Dependabot config](https://github.com/pnpm/pnpm/blob/9463e98c1eebc78a893c251f25a13393a1410020/.github/dependabot.yml) と [PR #13705](https://github.com/pnpm/pnpm/pull/13705) を確認した | [release workflow](https://github.com/pnpm/pnpm/blob/9463e98c1eebc78a893c251f25a13393a1410020/.github/workflows/release.yml) は maintainer の signed annotated tag、signature verification、registry state による再開、OIDC を明記する |
| [Fastify](https://github.com/fastify/fastify/tree/2e81c38bfede1858c3705c5a6f7753abd93019b3) / `fastify` | [Dependabot config](https://github.com/fastify/fastify/blob/2e81c38bfede1858c3705c5a6f7753abd93019b3/.github/dependabot.yml) と [PR #6917](https://github.com/fastify/fastify/pull/6917) | npm と GitHub Actions の major update だけを weekly、7 days cooldown、dependency group で運用する |
| [Changesets](https://github.com/changesets/changesets/tree/496ca21c53ac58b0d0e160a3af1fecfe39322564) / `@changesets/cli` | [Dependabot config](https://github.com/changesets/changesets/blob/496ca21c53ac58b0d0e160a3af1fecfe39322564/.github/dependabot.yml) と [PR #2225](https://github.com/changesets/changesets/pull/2225) | weekly、7 days cooldown、production と development の group を使い、[publish workflow](https://github.com/changesets/changesets/blob/496ca21c53ac58b0d0e160a3af1fecfe39322564/.github/workflows/publish.yml) は version と publish を分け、npm environment と OIDC を使う |
| [Express](https://github.com/expressjs/express/tree/a3714473feb3d2908add734d340e7755fd85e0a3) / `express` | [Dependabot config](https://github.com/expressjs/express/blob/a3714473feb3d2908add734d340e7755fd85e0a3/.github/dependabot.yml) と [PR #7403](https://github.com/expressjs/express/pull/7403) | monthly 更新で major を除外し、review volume を抑える |
| [Axios](https://github.com/axios/axios/tree/ba98559a7f5a18e531b5762387e5957bd281af3d) / `axios` | [Dependabot config](https://github.com/axios/axios/blob/ba98559a7f5a18e531b5762387e5957bd281af3d/.github/dependabot.yml) と [PR #11123](https://github.com/axios/axios/pull/11123) | weekly、7 days cooldown、grouping、major 除外を使い、[tag-triggered publish](https://github.com/axios/axios/blob/ba98559a7f5a18e531b5762387e5957bd281af3d/.github/workflows/publish.yml) は environment、OIDC、`npm stage publish` を使う |

### 調査から得た共通点

調査対象では標準型の Renovate と Dependabot の双方が現役であり、どちらか一方だけが npm OSS の事実上の標準という結果ではなかった。

Renovate の六つの確認例では PR head branch が target repository 自身の `renovate/*` であり、Forking Renovate の採用例ではなかった。

一方で、設定ファイルが残っていても pnpm の最後に確認できた Renovate PR は 2021 年であり、config の存在だけを現在の利用証拠にはしなかった。

更新頻度は weekly または monthly が中心で、non-major、production、development、GitHub Actions などの意味単位で group 化していた。

新規 release の待機には Vite と Vitest の minimum release age、Dependabot 採用 project では 7 days cooldown が使われていた。

調査した updater config に依存関係の全面 automerge を要求する設定はなく、major は approval または除外に寄せる例が多かった。

Vite と Prettier では通常更新の Renovate に加えて Dependabot author の security PR も観測し、ESLint では同じ GitHub Action を両 bot が更新していたため、二つの PR producer を併用すると責任範囲が重なることも確認した。

Vite、Vitest、pnpm、typescript-eslint、Babel、Changesets、Axios では publish trigger が tag、release commit、main push などに分かれていたが、dependency update Pull Request とは別の publish job または workflow を持ち、GitHub environment、job 単位の permission、OIDC を使っていた。

したがって、`depatrol` では updater の人気だけを模倣せず、広い更新対象を一つの policy で扱える Renovate と、tag-driven release の強い分離を組み合わせる。

## 参照リポジトリから引き継ぐ点

- [`necofuryai.dev`](https://github.com/necofuryai/necofuryai.dev/blob/main/.github/dependabot.yml) は Dependabot を PR 作成者とし、native Dependabot security updates も有効化している。
- [`genko-zed`](https://github.com/necofuryai/genko-zed/blob/main/renovate.json) は Renovate `vulnerabilityAlerts` を security PR 作成者とし、native Dependabot security updates を無効化している。
- [`necofuryai-personal-website`](https://github.com/necofuryai/necofuryai-personal-website/blob/main/renovate.json) も Renovate `vulnerabilityAlerts` を使うが、広い automerge policy は `depatrol` の tag-driven release 境界には持ち込まない。

三つの構成を併設して平均化するのではなく、`depatrol` では Renovate を唯一の PR 作成者とし、Dependabot alerts を検出器として残す。

## 推奨する制御構造

### 1. 標準 App の write permission を封じ込める

標準 Mend Renovate App は `depatrol` だけを対象に install し、all repositories への install は行わない。

`main` ruleset は Pull Request 経由を必須にし、Renovate Pull Request に maintainer 一名の approval を要求する。

direct collaborator が一名で自分の Pull Request を承認できないため、repository administrator には bypass mode `For pull requests only` を設定する。

この bypass は human maintainer の Pull Request を merge するためにだけ使い、direct push は引き続き禁止する。

approval 後の差し替えを防ぐため、stale approval の dismissal と most recent reviewable push の approval を有効にする。

Renovate App を `main` ruleset の bypass actor に追加せず、human approval と required checks の迂回を許可しない。

Renovate App は条件成立後の Pull Request を merge API で merge できる権限を持つため、`automerge: false` と `platformAutomerge: false` も維持する。

`main` の deletion と force push を禁止し、required checks は strict mode にする。

`test`、`dependency-review`、`release-preflight` は expected source を GitHub Actions に固定した required checks とする。

`.github/workflows/release.yml`、`.goreleaser.yaml`、`packaging/npm/**` は `CODEOWNERS` で release owner を指定し、ruleset で code owner review を必須にする。

solo maintainer が Renovate branch へ修正を push して latest-push approval を満たせなくなった場合も、required checks 成功と差分再確認後に限り administrator の `For pull requests only` bypass を使う。

Pull Request で実行する workflow は top-level `permissions: {}` から必要な job だけ `contents: read` を付与し、repository secret、release environment、`id-token: write`、`contents: write` を使わない。

`pull_request_target` で Pull Request branch の code を checkout または実行しない。

Renovate App に npm credential、release GitHub App credential、GPG private key を渡さない。

### 2. release 境界を先に固定する

GitHub の [tag ruleset](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets) は tag の creation、update、deletion を制限し、bypass actor を限定できる。

`v*` を対象に次の二つの active ruleset を作成する。

1. `release-tag-creation` は creation を制限し、release 操作を行う repository administrator だけを bypass actor にする。
2. `release-tag-immutability` は update と deletion を制限し、通常運用の bypass actor を設定しない。

Renovate App はどちらの bypass list にも追加しない。

ruleset 自体を変更できる administrator は緊急時に解除できるが、tag を直接動かす操作を通常経路から排除できる。

GitHub Actions は tag push event の commit に存在する workflow 定義を実行するため、hardening 前の古い `main` 祖先へ tag を作ると新しい `release-guard` 自体が存在しない。

Tag ruleset は target commit の世代まで制限できないため、hardening marker の初回追加 commit を baseline とする。
Release guard は tag target が baseline の子孫かつ検証済みの `main` 祖先であることを確認し、operator の通常手順では最新の green な `origin/main` に tag を作成する。

これは administrator の誤操作を GitHub 側で完全には防がない残余リスクであり、これを許容できない場合は tag push だけの自動公開をやめ、current default branch の `workflow_dispatch` release controller へ移行する。

release workflow の最初に `release-guard` job を追加し、後続の `github-release` と `npm` をこの job に `needs` で接続する。

`release-guard` は tag 名が `^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$` に完全一致することを検証する。

`release-guard` は tag ref が lightweight tag ではなく annotated tag object を指すことを GitHub Git Database API で検証する。

GitHub の [Git tags REST API](https://docs.github.com/en/rest/git/tags) は annotated tag object と `verification.verified` を返すため、release job は GitHub が署名を verified と判定した tag だけを許可できる。

tag ruleset の signed-commit rule を annotated tag object の署名検証とみなさず、署名の強制は `release-guard` の Git tags API 検証で行う。

署名済み annotated tag を新しい release invariant として ADR に記録し、信頼する public key を `.github/release-keys/` に commit する。

`release-guard` は隔離した keyring に repository 内の trusted key だけを import し、`git verify-tag` でも署名を検証する。

key rotation は古い public key を historical verification 用に残したまま新しい key を Pull Request で追加し、失効、端末移行、緊急 release の手順を runbook に定義する。

現行 runbook の lightweight tag command は `git tag -s` を使う手順へ変更する。

`release-guard` は tag object が指す commit を解決し、`git merge-base --is-ancestor <tag-commit> origin/main` が成功することを検証する。

`release-validation` job は tag commit から `test` と `release-preflight` の検証を再実行し、main merge 直後や失敗した CI commit に tag を付けても publish job へ進ませない。

PR と release で検証内容が drift しないよう、Go module integrity、build、vet、format、race test、`govulncheck`、`actionlint`、`goreleaser check`、snapshot packaging を同じ script または reusable workflow から呼び出す。

`release-validation` は `contents: read` だけを持ち、後続の build、GitHub Release、npm job はこの成功を `needs` で要求する。

tag filter の `v*` は workflow を起動するための粗い入口として残し、exact SemVer と release invariant は guard で強制する。

GitHub の [immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases) を repository で有効化する。

[GitHub の有効化手順](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/establish-provenance-and-integrity/prevent-release-changes) によれば immutability は future release にだけ適用され、既存 release は自動変換されない。

immutable release は公開後の tag 移動と削除、release asset の変更と削除を禁止し、tag、commit SHA、asset を結ぶ release attestation を生成する。

標準 Renovate App の Contents write は GitHub Releases API にも届くため、tag ruleset だけでは公開済み asset の差し替えを防げない。

immutable releases は App による silent replacement を防ぐが、release の削除による明示的かつ同一 tag では復旧不能な availability loss は防がない。

さらに、Contents write を持つ App は正規 workflow より先に既存 tag へ不正な Release を publish できるため、immutable であることだけを正規 build の証明にしてはならない。

release workflow は build を一度だけ行い、GitHub Release と npm package の共通入力を Actions artifact に変更する。

`release-build` job は `goreleaser release --skip=publish --clean` で archive と checksum を生成し、asset 名と SHA-256 を含む `release-manifest.json` を作成する。

同 job は [`attestations: write`、`id-token: write`、`artifact-metadata: write` で build provenance attestation を生成](https://github.com/actions/attest/tree/v4#usage)し、manifest と artifact を `actions/upload-artifact` v7 の immutable workflow artifact として upload する。

`github-release` job と `npm` job は同じ Actions artifact ID を download し、manifest、checksum、build attestation の workflow identity、repository、tag ref を検証してから処理する。

`npm` job は `github-release` job の成功も `needs` で要求し、GitHub Release が draft または検証失敗のまま npm だけを公開しない。

`npm` job は GitHub Release asset を build input にしない。

Actions artifact の `retention-days` は workflow run の再実行可能期間と同じ 30 日に固定し、保持期間を過ぎても npm が完了していない場合は同じ tag を再 build せず新しい patch release で復旧する。

これにより、標準 App が Release asset を先に作成または変更しても、正規 Actions build と一致しない binary が npm へ再 packaging されない。

`github-release` job は `gh release create --draft`、全 asset upload、manifest 照合、draft publish の順に行い、既存の changelog filter を維持する。

GoReleaser 自身の GitHub publisher を残す場合も既定の `release.draft: false` を維持し、job 成功後も draft のまま残す `draft: true` は設定しない。

`draft: true` の job が成功すると後続 npm job が先に公開され、GitHub Release だけ未公開になるためである。

[`.goreleaser.yaml`](../../.goreleaser.yaml) の `replace_existing_artifacts: true` を削除し、公開済み asset の upsert は行わない。

release retry は次の四状態として workflow と runbook に実装する。

1. Release が存在しなければ、正規 Actions artifact から draft を作成し、全 asset の一致を確認して publish する。
2. 不完全な draft が存在すれば、draft であることと tag target を確認して削除し、正規 Actions artifact から再生成する。
3. immutable Release が公開済みなら GoReleaser と upload を再実行せず、`gh release verify` に加えて全 asset の digest と正規 `release-manifest.json`、build attestation の一致を確認する。
4. GitHub Release 成功後に npm が失敗した場合は、同じ workflow run 内で同じ Actions artifact ID を入力に npm job だけを再実行する。

公開済み artifact 自体が誤っている場合や既存 immutable Release の検証が失敗した場合は、同じ tag を変更せず新しい patch version を release する。

immutable Release が削除された場合は Renovate App を uninstall または credential revoke し、audit log と tag を保全し、同じ tag 名を再利用せず新しい patch release で復旧する。

既存 `v0.1.0` と `v0.1.1` は導入直前に asset 一覧と checksum を再検証し、結果を release runbook に記録する。

同じ baseline を repository に commit し、`contents: read` だけの scheduled `release-integrity` job で既存二 release の asset 名と checksum を毎日照合する。

この job は過去 release の変更を防止せず検出する補償統制であり、drift 時は Renovate App を停止して audit log を確認する。

既存 release の削除と再作成による immutable 化は public history を変更する destructive migration になるため、この導入計画には含めない。

### 3. npm publish を environment でも拘束する

GitHub environment `npm-release` を作成し、deployment branch and tag rule を `v*` に限定して npm job に設定する。

[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) は GitHub repository、workflow filename、任意の environment name、許可する publish action を OIDC identity として登録できる。

六つの npm package の trusted publisher に `release.yml`、同じ `npm-release` environment 名、allowed action `npm publish` を登録し、workflow 側の job と npm 側の identity を一致させる。

npm 側の trusted publisher と workflow 側の environment 名を片方ずつ変更すると OIDC subject が一致しないため、この移行中は新しい `v*` tag の作成を停止する。

六 package すべての npm 設定と workflow を確認してから release tag freeze を解除する。

この environment は tag ruleset と release guard の代替ではなく、OIDC token を release job の文脈へ狭める追加防御である。

初期段階では environment reviewer を必須にせず、署名済み tag の push で自動 publish する既存の操作性を維持する。

最初の trusted publish が成功した後に traditional automation token を revoke し、各 package の publishing access を `Require two-factor authentication and disallow tokens` に変更する。

六 package は npm registry 上の public package であり、public repository と public package の組み合わせで trusted publishing を使うと npm provenance が自動生成されるため、実 release checklist で六 package すべての provenance を確認する。

[npm staged publishing](https://docs.npmjs.com/staged-publishing/) は maintainer の 2FA 承認前に package を非公開 stage へ置ける仕組みであり、npm は stage-only trusted publisher と token disallow の組み合わせを最大の security posture としている。

Axios は 2026-08-10 時点で tag-triggered workflow から `npm stage publish` を実行していた。

一方で npm の文書化された承認 command は一つの `stage-id` を対象とする `npm stage approve <stage-id>` であり、六 package を atomic に一括承認する機能は確認できなかった。

`depatrol` は platform package 五つを先に公開し、main package を最後に公開するため、publish command が返す六つの stage ID を workflow artifact として保存する必要がある。

trusted publishing の短命 OIDC token では `npm stage list` と `npm stage view` を実行できないため、状態確認と承認は WebAuthn 2FA を使う maintainer session から行う。

現行の `publish.mjs` は `npm view` で live version だけを調べるため、stage 済み version を検出できず、同一 tag の再実行で重複 stage を試みる可能性がある。

stage-only へ進む ADR では、platform 五 package を確認してから main package を承認する順序、`npm stage reject <stage-id>`、自前の確認期限、部分承認後の復旧、再実行の idempotency を先に定義する。

このため初期導入は direct trusted publish を維持し、二回の正常 release 後に stage-only へ移行するかを独立した release ADR で判断する。

### 4. Pull Request の gate と release preflight を増やす

[Dependency Review Action](https://github.com/actions/dependency-review-action) を Pull Request で実行し、少なくとも `moderate` 以上の既知脆弱性を新規導入する変更を失敗させる。

導入時点の公式 release は [`actions/dependency-review-action` v5.0.0](https://github.com/actions/dependency-review-action/releases/tag/v5.0.0) であり、workflow では full commit SHA `a1d282b36b6f3519aa1f3fc636f609c47dddb294` に固定する。

job 名 `dependency-review` を一度実行して GitHub が source App を認識した後、`test` と並ぶ required check に追加する。

license allowlist または denylist は repository の採用 policy が未定義なので、この導入と同時には有効化しない。

`test` には `go mod verify`、`go mod tidy -diff`、`go test -race ./...` を追加し、module metadata の整合性と race detector を dependency Pull Request でも検証する。

`govulncheck` と `actionlint` は [Go module の `tool` directive](https://go.dev/doc/modules/managing-dependencies#tools) を使う独立した [`tools` module](../../tools/go.mod) で version 管理する。

Application module の `go.yaml.in/yaml/v4` と actionlint が要求する release candidate は API が異なるため、tool を root module に混在させない。
CI は tools module から一時 binary を build し、repository root に対して `govulncheck` と `actionlint` を実行する。

2026-08-10 に `govulncheck@v1.6.0 ./...` を実装後の worktree で実行した結果は `No vulnerabilities found.` であった。

現行の `test` は release workflow、GoReleaser archive、npm 用の再 packaging を実行しないため、GitHub Actions、GoReleaser、Node.js、npm の更新が green でも、release path の互換性は未検証のままになる。

`release-preflight` は `contents: read` だけを与え、`contents: write` と `id-token: write` を与えず、Pull Request で次を実行する。

```text
goreleaser check
goreleaser release --snapshot --clean
node packaging/npm/prepare.mjs <snapshot-version> dist
node packaging/npm/publish.mjs packaging/npm/dist --dry-run
```

GoReleaser の snapshot metadata から `prepare.mjs` へ version を受け渡す小さな glue は必要だが、これにより cross-build、archive、checksum、npm 六 package の manifest と tarball を publish なしで検証できる。

dry run では GitHub Release の upload/download、npm OIDC、provenance、registry への実 publish は検証できないため、これらは実 tag の release checklist に残す。

`release-preflight` も一度実行した後、`test` と `dependency-review` に並ぶ required check にする。

### 5. GitHub Actions の supply-chain policy を強制する

[GitHub は full commit SHA を action の唯一の immutable reference と説明している](https://docs.github.com/en/actions/reference/security/secure-use)ため、repository の SHA pinning requirement を有効化する。

同じ GitHub 文書によれば、full commit SHA へ固定した Action には Dependabot alert が作成されない。

Renovate `vulnerabilityAlerts` も Dependabot alert を入力にするため、SHA-pinned Action の脆弱性だけは alert 経由で即時に優先できない。

Actions の allowlist は GitHub 作成 action と `goreleaser/goreleaser-action` に狭める。

[Renovate の GitHub Actions manager](https://docs.renovatebot.com/modules/manager/github-actions/) は full SHA と後続の version comment を組み合わせた参照を更新できる。

`helpers:pinGitHubActionDigests` preset を使い、将来追加される action も digest pinning の対象にする。

この gap による update latency を短くするため、`github-actions` manager だけは平日に更新確認し、`minimumReleaseAge` を 1 day に短縮する。

この polling は新版の検出であって脆弱性の分類ではないため、allowlist に含める Action repository の Security advisory 通知を release owner が監視し、緊急 advisory では maintainer が手動で update Pull Request を起票する。

それでも公開から最初の一日は自動更新しない設計であり、通知漏れは明示的な残余リスクとして受容する。

## Renovate の管理範囲

Renovate で有効にする manager は `gomod`、`github-actions`、`nodenv`、`custom.regex` の四つに限定する。

`npm` manager を有効にしないことで、release 用の `packaging/npm/depatrol/package.json` と managed version placeholder を更新対象から除外する。

[Go Modules manager](https://docs.renovatebot.com/modules/manager/gomod/) は root と `tools` の両 module から `require`、`indirect`、`tool`、`golang` などの dependency type を抽出するが、既定では `go` directive を更新しない。

Go toolchain は `go.mod` から CI と release build の両方へ伝播するため、`go` dependency だけ `rangeStrategy: bump`、平日 schedule、`minimumReleaseAge: 1 day` を指定する。
最新版追従を優先して Go update は Dependency Dashboard approval を要求しないが、automerge は無効のため manual review と merge は維持する。

direct Go module の non-major update は一つの group にまとめ、major update は Dependency Dashboard で承認されるまで Pull Request を作成しない。

GitHub Actions update は group 化してよいが、`release.yml` に触れる更新は Dashboard approval と manual merge を要求する。

`goreleaser/goreleaser-action` の `with.version` は通常の action ref ではないため、[`custom.regex` manager](https://docs.renovatebot.com/modules/manager/regex/) と `github-releases` datasource で `v2.17.1` を追跡する。

実装前の `node-version: "24"` と `npm@11` は release ごとに異なる patch version を解決し得たため、Node.js `24.19.0` と npm `11.19.0` に固定した。

Node.js は `.node-version` に固定して `actions/setup-node` の `node-version-file` から読み、`nodenv` manager で更新する。

npm CLI は `npm install -g npm@<exact-version>` に annotation を付け、`custom.regex` manager と `npm` datasource で更新する。

Renovate に application version、Git tag、npm package version を bump させる設定は追加しない。

Renovate の [`:gitSignOff` preset](https://docs.renovatebot.com/presets-default/#gitsignoff) を使って DCO trailer を付け、`:semanticCommitScopeDisabled` で repository の `chore: ...` 規約に合わせる。

Dependency Dashboard は pending、open、ignored、approval 待ちを一つの Issue に集約し、[vulnerability alert の修正は Dashboard approval を待たずに作成される](https://docs.renovatebot.com/key-concepts/dashboard/)。

## `renovate.json` の実装

調査時の叩き台は [renovate.json](../../renovate.json) として実装した。
実装後の設定 file を正とし、本調査文書に duplicate JSON は保持しない。

Custom manager は CI と release の両 workflow にある GoReleaser と npm CLI の exact version を検出する。
Mend-hosted App は organization 設定を repository 設定へ継承する。
別 repository 向けの base branch が継承されても `depatrol` の実在しない branch を探索しないよう、`baseBranchPatterns` は `"$default"` を明示する。
これにより、現在の `main` を文字列で固定せず、GitHub の default branch を使う。

## automerge の境界

初期導入では dependency type や update type を問わず automerge を無効にする。

特に Go toolchain、major module、GitHub Actions、GoReleaser、release workflow、`vulnerabilityAlerts` の Pull Request は恒久的に manual merge の候補とする。

二回以上の定期更新 cycle で、Pull Request の生成、DCO、`gomodTidy`、required checks、target repository 内 branch 由来の workflow、Dashboard、security fix の挙動を確認する。

その後も automerge は既定で無効のままにし、必要性と rollback 実績が確認できた low-risk patch だけを別の設計変更として評価する。

将来 automerge を限定導入しても bot を tag ruleset の bypass actor にせず、`test`、`dependency-review`、`release-preflight` を required check にしたままにする。

[Renovate の automerge は既定で無効](https://docs.renovatebot.com/key-concepts/automerge/)であり、branch protection の required checks が正しく構成されて初めて安全側に働く。

## 導入順序

1. Dependency graph と Dependabot alerts を有効化し、Dependabot security updates と version updates は無効のまま確認する。
2. 現行 protection を外す前に同等以上の `main` ruleset を active にし、Pull Request、maintainer 一名の approval、stale dismissal、latest-push approval、既存 `test` source、repository administrator の `For pull requests only` bypass を設定する。
3. `v*` tag の creation、update、deletion ruleset を導入し、Renovate と GitHub Actions に bypass を与えない。
4. Signed annotated tag の ADR、hardening marker、trusted public key、key rotation runbook、`release-guard`、build-once release、既存 release baseline、daily integrity check を merge する。
5. Dependency Review、`govulncheck`、Go module integrity checks、`actionlint`、`release-preflight`、`renovate.json`、`.node-version` を merge し、新しい check を少なくとも一度 GitHub Actions から実行する。
6. GitHub が check source を認識した後に `test`、`dependency-review`、`release-preflight` を GitHub Actions source の required checks にする。
7. Actions の full-SHA requirement と allowlist を有効化する。
8. Future release の immutability を有効化し、Administration read token で設定を確認してから repository variable `IMMUTABLE_RELEASES_ENABLED=true` を設定する。
9. Release tag freeze を開始し、`npm-release` environment と六つの npm trusted publisher を `release.yml`、同 environment、allowed action `npm publish` に揃える。
10. 六 package の設定一致を確認して release tag freeze を解除する。
11. 標準 Mend Renovate App を `depatrol` だけに install し、default branch の設定を読み込ませる。
12. 最初の二回の更新 cycle はすべて manual merge し、DCO、対象 file、required checks、tag 非作成、npm 非公開を確認する。
13. 次の正常 release で immutable release、build attestation、六 package の npm provenance を確認する。
14. npm publish が失敗した実 workflow で、同一 run の failed jobs retry が元の Actions artifact を使うことを確認する。
15. 二回の正常 release 後に npm stage-only trusted publishing へ進むかを独立した ADR で判断する。

## 受け入れ条件

設定と merge の時点で判定できるのは、config validation、manager extraction、CI、ruleset、required checks、permission、release guard の negative test である。

Renovate branch の生成と cleanup、vulnerability fix、最初の二回の update cycle、最初の scheduled release-integrity 実行、次回 release、実 workflow の npm retry は導入後の観察項目として別に完了判定する。

- 標準 Renovate App が Fork を作らず、target repository 内の `renovate/*` branch から Pull Request を作成する。
- merge、close、不要化した未改変の `renovate/*` branch が次回 Renovate 実行で削除される。
- Renovate が `go.mod`、GitHub Actions の full SHA、GoReleaser、Node.js、npm CLI version の更新候補を検出できる。
- `packaging/npm/depatrol/package.json` の managed placeholder を変更する Pull Request を作成しない。
- Renovate の commit に `Signed-off-by` trailer があり、title と commit が scope なしの Conventional Commits 形式になる。
- 通常更新と vulnerability fix の Pull Request 作成者が Renovate 一つだけになる。
- Go module の vulnerability fix は weekly schedule を待たずに作成されるが、自動 merge されない。
- SHA-pinned GitHub Actions は平日に確認され、通常の 7 days ではなく 1 day の release age 後に更新候補が作成される。
- Renovate が `main` と `v*` tag へ直接 push できず、required check と human approval を代替できない。
- bot Pull Request の merge だけでは `release.yml` が起動せず、npm publish も発生しない。
- `v*` tag の更新と削除が通常権限では拒否される。
- hardening baseline 以後の workflow では、exact SemVer でない tag、trusted key で署名されていない tag、lightweight tag、`main` の祖先でない tag は release asset 作成前に失敗する。
- hardening 前の `main` 祖先への tag 作成は release operator の trust boundary として runbook で禁止され、GitHub ruleset 単独では強制できないことが記録される。
- `test`、`dependency-review`、`release-preflight` がすべて成功しなければ dependency Pull Request を merge できない。
- 導入後に公開する GitHub Release の asset と tag が immutable で、`gh release verify`、manifest、asset digest、build attestation identity の検証がすべて成功する。
- 既存 `v0.1.0` と `v0.1.1` の mutable asset 一覧と checksum の導入前 baseline が runbook に記録される。
- scheduled integrity check が既存二 release と baseline の不一致を検出する。
- GitHub Release 公開後の npm 失敗は同じ workflow run の Actions artifact ID を入力に npm job だけを再実行できる。
- 六つの npm package に provenance があり、traditional automation token なしで publish できる。
- Mend-hosted service 終了時の Dependabot 縮退手順と self-hosted Renovate 移行手順が runbook に記録される。

## 採用しない構成

- Forking Renovate は target repository への write permission を減らせるが、限定的な hosted variant への依存を避けるため採用しない。
- Dependabot-only は GitHub-native で継続性が最も強いが、GoReleaser `with.version`、npm CLI、Node.js、DCO trailer を同じ policy で更新できないため採用しない。
- Dependabot version updates と Renovate を ecosystem ごとに分担すると設定、Dashboard、PR author、security fix の責任境界が分かれるため採用しない。
- Dependabot security updates と Renovate `vulnerabilityAlerts` の同時有効化は同じ alert から複数の修正 Pull Request を作る可能性があるため採用しない。
- Renovate の experimental な OSV vulnerability alerts は、GitHub Dependabot alerts と役割が重なり、[現時点では direct dependency のみを対象にする](https://docs.renovatebot.com/configuration-options/#osvvulnerabilityalerts)ため追加しない。
- self-hosted Renovate は bot 自体の update、credential、schedule、runtime、isolation を新たに運用する必要があるため、Mend-hosted App で満たせる現状では採用しない。
- npm staged publishing は release 操作モデルを変えるため、dependency automation の初期導入へ同梱しない。

## 一次資料

- [Dependabot quickstart](https://docs.github.com/en/code-security/tutorials/secure-your-dependencies/dependabot-quickstart)
- [Dependabot alerts](https://docs.github.com/en/code-security/concepts/supply-chain-security/dependabot-alerts)
- [Dependabot security updates](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/configure-security-updates)
- [Dependabot version updates](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/configure-version-updates)
- [Dependency Review](https://docs.github.com/en/code-security/concepts/supply-chain-security/dependency-review)
- [Dependency Review Action](https://github.com/actions/dependency-review-action)
- [GitHub rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)
- [Git tags REST API](https://docs.github.com/en/rest/git/tags)
- [GitHub immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)
- [Enable GitHub release immutability](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/establish-provenance-and-integrity/prevent-release-changes)
- [GitHub release integrity verification](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/verify-release-integrity)
- [GitHub Actions secure use](https://docs.github.com/en/actions/reference/security/secure-use)
- [GitHub Actions workflow concepts](https://docs.github.com/en/actions/concepts/workflows-and-actions/workflows)
- [GitHub artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)
- [`actions/upload-artifact` v4 migration](https://github.com/actions/upload-artifact/blob/main/docs/MIGRATION.md)
- [Mend-hosted Renovate](https://docs.renovatebot.com/mend-hosted/overview/)
- [Forking Renovate](https://docs.renovatebot.com/getting-started/running/#forking-renovate-app)
- [Renovate security and permissions](https://docs.renovatebot.com/security-and-permissions/)
- [Renovate configuration overview](https://docs.renovatebot.com/config-overview/)
- [Renovate self-hosted configuration](https://docs.renovatebot.com/self-hosted-configuration/)
- [Renovate vulnerability alerts](https://docs.renovatebot.com/configuration-options/#vulnerabilityalerts)
- [Renovate Go Modules manager](https://docs.renovatebot.com/modules/manager/gomod/)
- [Renovate GitHub Actions manager](https://docs.renovatebot.com/modules/manager/github-actions/)
- [Renovate regex manager](https://docs.renovatebot.com/modules/manager/regex/)
- [Renovate best-practices preset](https://docs.renovatebot.com/presets-config/#configbest-practices)
- [Go vulnerability management](https://go.dev/doc/security/vuln/)
- [Go tool dependencies](https://go.dev/doc/modules/managing-dependencies#tools)
- [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
- [npm staged publishing](https://docs.npmjs.com/staged-publishing/)
- [npm stage command](https://docs.npmjs.com/cli/v11/commands/npm-stage/)
- [GoReleaser GitHub releases](https://goreleaser.com/customization/publish/scm/)
