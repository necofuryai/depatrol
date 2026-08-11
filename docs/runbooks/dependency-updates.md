# Dependency update runbook

depatrol 自身の dependency update と merge gate を運用する手順を定める。
これは depatrol の製品機能として Renovate scanner adapter を実装するものではない。

## Responsibility split

| Component | Responsibility |
|---|---|
| Mend-hosted Renovate App | 通常更新と脆弱性修正の Pull Request を作成する。 |
| Dependabot alerts | Dependency graph を基に default branch の既知脆弱性を通知する。 |
| Dependency Review | Pull Request が新しく導入する既知脆弱性を merge 前に拒否する。 |
| govulncheck | Go binary から到達可能な既知脆弱性を検出する。 |
| Maintainer | Update の内容、release preflight、互換性を確認して merge を判断する。 |

Dependabot version updates と Dependabot security updates は無効のままにする。
通常時の Pull Request producer は Renovate だけに限定し、重複 Pull Request を作らない。
Forking Renovate App は使わず、標準 Mend-hosted App が target repository 内の `renovate/*` branch を使う。

## Renovate policy

[renovate.json](../../renovate.json) は manager を `gomod`、`github-actions`、`nodenv`、`custom.regex` に限定する。
`baseBranchPatterns` は `"$default"` を明示し、Mend の organization 設定を継承しても GitHub の default branch を使う。
`npm` manager は有効化しない。
`packaging/npm/depatrol/package.json` の version は release 時に生成する placeholder であり、dependency update の対象ではない。

全 update で automerge を禁止する。
Pull Request と commit は semantic commit を使い、scope を付けず、DCO sign-off を付ける。

通常の update は月曜日の 06:00 JST より前に確認し、release から 7 日経過した version を対象にする。
GitHub Actions と Go toolchain は平日に確認し、release から 1 日経過した version を対象にする。
Go は最新 stable を優先し、major 相当の更新でも Dashboard approval を待たずに Pull Request を作成する。
Automerge は行わないため、最終判断は maintainer review に残る。

Go module と GitHub Actions の non-major update は、それぞれ一つの Pull Request にまとめる。
一般 dependency の major update、release workflow の変更、GoReleaser と npm CLI の更新は Dependency Dashboard で作成を承認する。
脆弱性修正は通常 schedule と minimum release age を待たず、`security` label を付ける。

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
3. Changelog、breaking changes、Go toolchain requirement、GitHub Action permission changesを確認する。
4. `test`、`dependency-review`、`release-preflight` が最新 head SHA で成功していることを確認する。
5. Release workflow、GoReleaser、Node.js、npm CLI の変更では [release runbook](release.md) の build-once invariant と permission を追加で確認する。
6. Maintainer が明示的に approve してから merge する。

更新後に失敗した check を、更新とは無関係と決めつけて merge してはならない。
Re-run で一時障害かを確認し、再現する場合は dependency change との因果を切り分ける。

## Vulnerability response

Dependabot alert または Renovate vulnerability Pull Request を検知したら、影響 package、severity、到達可能性、fix version を確認する。
Go dependency は `govulncheck` の symbol-level result も確認する。

Fix が利用可能な場合は schedule を待たずに Pull Request を review する。
Fix がない場合は exposure、runtime path、temporary mitigation を issue または security advisory に記録する。
Public issue に未公開 vulnerability detail や credential を書かない。

## Routine checks

毎週、Dependency Dashboard で rate limit、pending major update、stale branch、設定 error を確認する。
最初の 2 update cycle では次を観測する。

- `go.mod`、`tools/go.mod`、`.node-version`、GitHub Actions、GoReleaser、npm CLI が検出される。
- npm package template が誤って update 対象にならない。
- 同一 dependency の Renovate Pull Request と Dependabot Pull Request が重複しない。
- Closed または obsolete な Renovate branch が cleanup される。
- DCO、title、labels、grouping が policy どおりになる。

これらは実際の update 発生後に確認する項目であり、設定 merge 時点では完了扱いにしない。

## Hosted service failure

Mend-hosted service が停止または終了した場合は Renovate App を無効化し、重複実行を防いでから縮退する。

短期の縮退では `.github/dependabot.yml` を追加し、`gomod` と `github-actions` だけを対象にする。
GoReleaser、Node.js、npm CLI は manual update と `release-preflight` で維持する。
これは一時運用であり、通常構成では `.github/dependabot.yml` を置かない。

長期化する場合は Renovate の self-hosted runner を default branch の設定から起動する。
移行時は同じ `renovate.json` を再利用し、新しい bot identity の permission、DCO、ruleset、same-repository branch、concurrency lock への影響を確認する。
Hosted App と self-hosted job を同時に動かしてはならない。
