# Dependency update runbook

depatrol 自身の dependency update と merge gate を運用する手順を定める。
これは depatrol の製品機能として Renovate scanner adapter を実装するものではない。

## Responsibility split

| Component | Responsibility |
|---|---|
| Mend-hosted Renovate App | 通常更新と脆弱性修正の Pull Request を作成する。 |
| Dependabot alerts | Dependency graph を基に default branch の既知脆弱性を通知する。 |
| Dependency Review | Pull Request が新しく導入する既知脆弱性を merge 前に拒否する。 |
| `bun audit` | `bun.lock` に含まれる開発依存・推移的依存の `moderate` 以上の既知脆弱性を CI・release validation で拒否する。 |
| Maintainer | Update の内容、release preflight、互換性を確認して merge を判断する。 |

Dependabot version updates と Dependabot security updates は無効のままにする。
通常時の Pull Request producer は Renovate だけに限定し、重複 Pull Request を作らない。
Forking Renovate App は使わず、標準 Mend-hosted App が target repository 内の `renovate/*` branch を使う。

## Renovate policy

[renovate.json](../../renovate.json) は manager を **`bun`、`bun-version`、`nodenv`、`github-actions`、`custom.regex`** の 5 つに限定する。

| manager | 対象ファイル・役割 |
|---|---|
| `bun` | ルートの `package.json` と `bun.lock`（`devDependencies` のみ、実行時 `dependencies` はゼロ） |
| `bun-version` | `.bun-version`（CI・local の Bun ツールチェーン pin） |
| `nodenv` | `.node-version`（CI・release の Node.js ツールチェーン pin） |
| `github-actions` | `.github/workflows/*.yml` の full SHA 固定アクション |
| `custom.regex` | `.github/workflows/{ci,release}.yml` 内の `npm` CLI バージョンおよび `rhysd/actionlint`（`ACTIONLINT_VERSION`） |

`baseBranchPatterns` は `"$default"` を明示し、Mend の organization 設定を継承しても GitHub の default branch を使う。

`package.json` の `engines.node` は `packageRules`（`matchManagers: ["bun"]`、`matchDepTypes: ["engines"]`、`enabled: false`）により明示的に Renovate の対象外とする。
`engines.node` の下限は「maintenance が継続している最古の Node 系統」という運用規則に従うため、[release runbook](release.md) に従って手動で見直す。

全 update で automerge を禁止する（`automerge: false`、`platformAutomerge: false`）。
Pull Request と commit は semantic commit を使い、scope を付けず、DCO sign-off を付ける。

通常 update の `schedule` は `"at any time"` を明示し、Mend の organization 設定を継承しても狭い時間枠で制限しない。
Mend-hosted Community の job 実行時刻と queue 遅延は repository から予約できず、時間枠を設定すると job が成功しても branch 作成をスキップするためである。
通常の update（`devDependencies`、`.bun-version`、`.node-version`、`custom.regex` 等）は release から **7 日**、`github-actions` は **1 日**経過した後、次の Mend job で Pull Request 作成対象にする。

`devDependencies` の minor / patch update は `devDependencies` グループ、`github-actions` の minor / patch / digest update は `GitHub Actions` グループとして、それぞれ一つの Pull Request にまとめる。
全 dependency の major update、`.github/workflows/release.yml` の変更、`custom.regex`（`npm` CLI と `rhysd/actionlint`）の更新は `dependencyDashboardApproval: true` とし、Dependency Dashboard で作成を承認する。
脆弱性修正（`vulnerabilityAlerts`）は minimum release age を待たず、`security` label を付ける（`automerge: false`）。

`.node-version` の Node.js および `.bun-version` の Bun は Dependabot alerts の対象外であり、それぞれの security release は Renovate の vulnerability Pull Request にならない。
そのため通常の update と同じく minimum release age（7 日）を待ち、Dependency Dashboard の Pending Status Checks に留まる。
Dashboard の項目は Pull Request の title しか示さないため、Node.js や Bun の update が security release かはそれぞれの公式 release notes で確認する。
Security release であれば、maintainer が Dashboard の該当 checkbox を選択し、minimum release age を待たずに Pull Request を作成させる。
こうして作成した Pull Request には `security` label が付かず、`renovate/stability-days` は minimum release age を満たすまで pending のままになる。
この check は required checks に含まれないため、pending のままでも merge を妨げない。
Merge は他の update と同じく Review procedure の全手順で判断し、Bun / Node.js の変更に求められる [release runbook](release.md) の確認も省かない。

## Installation order

1. GitHub Dependency graph と Dependabot alerts を有効化する。
2. Dependabot security updates と version updates が無効であることを確認する。
3. `security` label を作成する。
4. CI を一度実行し、`test`、`dependency-review`、`release-preflight` を GitHub Actions の required checks として登録する。
5. `renovate.json` を default branch に merge する。
6. 標準 Mend Renovate App を `necofuryai/depatrol` だけに install する。
7. App が既存 `renovate.json` を直接読み、Dependency Dashboard と最初の update Pull Request を作成することを確認する。

Dependency graph の有効化は Dependency Review の required 化より先に行う。
Renovate App を all repositories へ install しない。
Renovate App と bot user を ruleset bypass actor に追加しない。

## Review procedure

1. Pull Request author と head branch を確認する。
   標準構成では target repository 内の `renovate/*` branch になる。
2. Title に scope がなく、commit に `Signed-off-by` があることを確認する。
3. Changelog、breaking changes、Bun / Node.js 互換性（実行時 `dependencies` や lifecycle スクリプトが追加されていないこと、Node.js 22+ / Bun 両互換が保たれていること）、GitHub Action permission changes を確認する。
4. `test`、`node-compat`、`dependency-review`、`release-preflight` が最新 head SHA で成功していることを確認する。
5. Release workflow、Bun、Node.js、npm CLI、`actionlint` の変更では [release runbook](release.md) の build-once invariant、permission、および Actions allowlist を追加で確認する。
6. Maintainer が明示的に approve してから merge する。

更新後に失敗した check を、更新とは無関係と決めつけて merge してはならない。
Re-run で一時障害かを確認し、再現する場合は dependency change との因果を切り分ける。

## Vulnerability response

Dependabot alert、`bun audit`（CI の `test` / `release-validation`）、または Renovate vulnerability Pull Request を検知したら、影響 package、severity、到達可能性（開発専用 `devDependencies` に留まるか、バンドルへ取り込まれるか）、fix version を確認する。

Fix が利用可能な場合は Pull Request を速やかに review する。
Fix がない場合は exposure、runtime path、temporary mitigation を issue または security advisory に記録する。
Public issue に未公開 vulnerability detail や credential を書かない。

## Routine checks

毎週、Dependency Dashboard で rate limit、pending major update、stale branch、設定 error を確認する。
Pending Status Checks に Node.js や Bun の update が留まっていれば、Renovate policy の手順で security release かを確認する。
Mend Developer Portal では、最後の job の開始時刻、完了時刻、status も確認する。
長時間 pending の job や実行間隔の欠落を repository 設定の schedule 待ちと混同しない。
`v0.2.0` のマネージャ切替後、最初の 2 update cycle では次を観測する。

- `package.json` / `bun.lock`、`.bun-version`、`.node-version`、GitHub Actions、`npm` CLI、`rhysd/actionlint` が検出される。
- `package.json` の `engines.node` が誤って update 対象にならない。
- 同一 dependency の Renovate Pull Request と Dependabot Pull Request が重複しない。
- Closed または obsolete な Renovate branch が cleanup される。
- DCO、title、labels、grouping が policy どおりになる。

これらは実際の update 発生後に確認する項目であり、設定 merge 時点では完了扱いにしない。

## Hosted service failure

Mend-hosted service が停止または終了した場合は Renovate App を無効化し、重複実行を防いでから縮退する。

短期の縮退では `.github/dependabot.yml` を追加し、パッケージ依存と `github-actions` を対象にする。
Bun（`.bun-version`）、Node.js（`.node-version`）、`npm` CLI、`actionlint` は manual update と `verify.sh` / `release-preflight` で維持する。
これは一時運用であり、通常構成では `.github/dependabot.yml` を置かない。

長期化する場合は Renovate の self-hosted runner を default branch の設定から起動する。
移行時は同じ `renovate.json` を再利用し、新しい bot identity の permission、DCO、ruleset、same-repository branch、concurrency lock への影響を確認する。
Hosted App と self-hosted job を同時に動かしてはならない。
