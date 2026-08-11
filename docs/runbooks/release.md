# Release runbook

[ADR 0006](../decisions/0006-distribution.md) と [ADR 0007](../decisions/0007-build-once-immutable-release.md) の運用手順を定める。
配布 channel の選択は ADR 0006、release integrity と retry 境界は ADR 0007 を正とする。
Version と外部サービスの仕様は 2026-08-10 に確認した。

## Pipeline

Pull Request と `main` push では [ci.yml](../../.github/workflows/ci.yml) が次を実行する。

- `test` は module integrity、build、vet、format、race test、`govulncheck`、`actionlint`、release script の unit test を実行する。
- `dependency-review` は Pull Request が追加する `moderate` 以上の既知脆弱性を拒否する。
- `release-preflight` は write permission と OIDC を持たず、GoReleaser snapshot と npm dry-run までを実行する。

Signed tag の push では [release.yml](../../.github/workflows/release.yml) が次の順に動く。

```text
release-guard
    ↓
release-validation
    ↓
release-build ── attested Actions artifact
    ├── github-release
    └── github-release 成功後 ── npm
```

Publish 可能な最終 bundle を生成するのは `release-build` だけである。
`release-validation` は publish permission を持たず、GoReleaser snapshot だけを実行する。
GitHub Release と npm は `release-${tag}-${commit}` という同じ Actions artifact を入力にする。
Artifact は 30 日保持し、同名 upload の上書きを禁止する。

GoReleaser の publisher は [.goreleaser.yaml](../../.goreleaser.yaml) で無効化する。
Release build は `--skip=publish` を必須とし、明示した ldflags で version、full commit、commit date を埋め込む。

現在の固定 version は次のとおりである。

| 対象 | version | 固定方法 |
|---|---:|---|
| Go | `1.26.5` | `go.mod` |
| Node.js | `24.19.0` | `.node-version` |
| npm CLI | `11.19.0` | workflow 内の exact version |
| GoReleaser | `v2.17.1` | workflow 内の exact version |
| actionlint | `v1.7.12` | `tools/go.mod` |
| govulncheck | `v1.6.0` | `tools/go.mod` |

Go は最新 stable を追従する。
Renovate は Go toolchain を平日に確認し、release から 1 日後に更新 Pull Request を作成する。
CI は `actions/setup-go` が `go.mod` を読み、local Mac の mise 設定には依存しない。

Workflow で使う action は full commit SHA に固定する。

| action | tag | commit SHA |
|---|---|---|
| `actions/checkout` | `v7.0.1` | `3d3c42e5aac5ba805825da76410c181273ba90b1` |
| `actions/setup-go` | `v7.0.0` | `b7ad1dad31e06c5925ef5d2fc7ad053ef454303e` |
| `actions/setup-node` | `v7.0.0` | `820762786026740c76f36085b0efc47a31fe5020` |
| `actions/dependency-review-action` | `v5.0.0` | `a1d282b36b6f3519aa1f3fc636f609c47dddb294` |
| `goreleaser/goreleaser-action` | `v7.2.3` | `f06c13b6b1a9625abc9e6e439d9c05a8f2190e94` |
| `actions/attest` | `v4.2.2` | `1e69f48acb82d1966a394da916b4c1698aa569d6` |
| `actions/upload-artifact` | `v7.0.1` | `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a` |
| `actions/download-artifact` | `v8.0.1` | `3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c` |

## External configuration

Local workflow を有効化する前に、repository と npm に次を設定する。

1. GitHub Dependency graph と Dependabot alerts を有効化する。
   Dependabot security updates と version updates は無効のままにする。
2. `main` ruleset で Pull Request、stale review dismissal、latest push approval、CODEOWNERS review、strict required checks を必須にする。
   Required checks は新しい job が GitHub Actions で一度成功した後に `test`、`dependency-review`、`release-preflight` を登録する。
   Renovate Pull Request は maintainer が承認する。
   Sole maintainer 自身の Pull Request では独立承認を満たせないため、admin の PR-only bypass を意図的な例外として使う。
3. `release-tag-creation` ruleset で `v*` tag の creation を制限し、release operator の repository role だけに `always` bypass を与える。
   Renovate App と GitHub Actions には bypass を与えない。
4. `release-tag-immutability` ruleset で `v*` tag の update と deletion を制限し、通常運用の bypass actor を設定しない。
   Creation 用 bypass をこの ruleset に流用してはならない。
5. Actions policy は GitHub-owned actions と `goreleaser/goreleaser-action` だけを許可し、full SHA pinning を必須にする。
6. Repository-level immutable releases を有効化する。
   この設定は新しい release にだけ適用され、既存 release は immutable にならない。
7. Administration read token で immutable releases endpoint の `enabled: true` を確認してから、repository variable `IMMUTABLE_RELEASES_ENABLED=true` を設定する。
   Release workflow の `GITHUB_TOKEN` には Administration read permission がないため、workflow から repository setting endpoint を直接確認しない。
   Repository variable は rollout 完了の fail-closed acknowledgement とし、公開後は release 自体の `isImmutable` を検証する。
8. 新しい release tag の作成を一時停止する。
9. GitHub environment `npm-release` を作成し、deployment branch and tag rule を `v*` に限定する。
10. npm の 6 package 全てで trusted publisher を `necofuryai/depatrol`、`release.yml`、environment `npm-release`、`npm publish` 許可として登録する。
11. 6 package の設定が一致することを確認してから release tag freeze を解除する。
12. 最初の trusted publish 成功後に traditional automation token が残っていれば revoke し、各 package の publishing access を token 不許可へ強化する。

Dependency graph を無効のまま `dependency-review` を required にすると、導入 Pull Request 自体が失敗する。
必ず手順 1 を CI の required 化より先に実施する。

## Tag guard

`release-guard` は次を全て検証する。

- Tag 名が `vMAJOR.MINOR.PATCH` と完全一致し、leading zero や prerelease suffix がない。
- Tag が lightweight tag ではなく annotated tag である。
- `.github/release-keys/` の公開鍵で tag signature を検証できる。
- GitHub Git Database API でも tag signature が `verified: true`、`reason: valid` である。
- Tag commit が `.github/release-hardening-baseline` を最初に追加した commit 以後である。
- Tag commit が `origin/main` の祖先である。
- Push event の SHA と annotated tag が指す commit が一致する。

Tag commit と実行時点の `origin/main` tip の一致は要求しない。
Release 実行中に `main` が進んでも正しい release を失敗させないためである。
Operator の通常手順では、曖昧さを避けるため最新の green な `origin/main` に tag を付ける。

Hardening 導入前の commit には guard 自体が存在しない。
そのため tag ruleset と release operator の運用は trust boundary に残る。

## Release procedure

1. Release 対象を merge した Pull Request で `test`、`dependency-review`、`release-preflight` が green だったことを確認する。
   `main` push では PR 専用の `dependency-review` は skip されるため、`main` 上では `test` と `release-preflight` の成功を確認する。
2. Local の `main` を `origin/main` に fast-forward し、release 対象 commit を固定する。
3. 表に記載した exact Node.js、npm、GoReleaser を有効にし、CI と同じ検証を local でも実行する。

   ```console
   bash scripts/ci/verify.sh
   bash scripts/release/preflight.sh
   ```

4. Release notes の差分を確認し、signed annotated tag を作成する。

   ```console
   git tag -s vX.Y.Z -m "depatrol vX.Y.Z"
   git verify-tag vX.Y.Z
   git push origin vX.Y.Z
   ```

5. `release-guard`、`release-validation`、`release-build`、`github-release`、`npm` が順に成功したことを確認する。
6. GitHub Release が immutable で、manifest、asset digest、attestation が検証できることを確認する。

   ```console
   gh release view vX.Y.Z --json tagName,isDraft,isImmutable,assets
   gh release verify vX.Y.Z --repo necofuryai/depatrol
   gh attestation verify depatrol_X.Y.Z_darwin_arm64.tar.gz \
     --repo necofuryai/depatrol \
     --signer-workflow necofuryai/depatrol/.github/workflows/release.yml \
     --source-ref refs/tags/vX.Y.Z
   ```

7. npm の 6 package が同じ version で公開され、provenance が付いていることを確認する。

## Build artifact and manifest

`scripts/release/artifacts.mjs` は 5 archive、checksum file、release notes、manifest の file set を固定する。
Manifest は tag、full commit、各 file の size と SHA-256 digest を記録する。
作成直後、download 後、GitHub Release 公開前後に同じ verifier を実行する。

`actions/attest` は bundle 内の各 file に build provenance を付与する。
`release-build` には `id-token: write`、`attestations: write`、`artifact-metadata: write` が必要である。
Consumer job は `attestations: read` だけを持ち、`gh attestation verify` で source repository、workflow、tag、commit を確認する。

## GitHub Release retry

| 状態 | 動作 |
|---|---|
| Release が存在しない | Bot が draft を作成し、全 asset を検証してから publish する。 |
| `github-actions[bot]` の draft が存在する | Draft を削除して元の Actions artifact から再作成する。 |
| 別 actor の draft が存在する | 自動削除せず停止し、operator が内容を確認する。 |
| 正しい immutable release が存在する | Asset と attestation を再検証し、成功済みとして終了する。 |
| Mutable release または digest 不一致 | 同じ tag を修復せず停止し、新しい patch release を要求する。 |

公開処理は draft に全 asset を upload し、manifest と remote digest が一致してから publish する。
公開後に `isImmutable: true` にならなければ失敗する。
Draft は tag-name endpoint の取得対象外である。
公開前の検出には全ページを取得した Releases 一覧を使い、再検証と公開には一覧で確定した release ID を使う。
Tag-name endpoint は、公開後に同じ release ID を返すことの検証にだけ使う。

## npm publish and retry

`packaging/npm/prepare.mjs` は Actions artifact の archive を 6 package に staging する。
`packaging/npm/publish.mjs` は全 package を先に `npm pack --json` し、tarball と SRI を固定する。
Platform package を先に publish し、main package `depatrol` を最後に publish する。

同じ version が registry に存在する場合は、`dist.integrity` と local tarball の SRI が完全一致するときだけ skip する。
Version が存在しても SRI が異なる場合は、1 package も追加 publish せず失敗する。

GitHub Release 成功後に npm だけが失敗した場合は、30 日以内に同じ workflow run の failed jobs だけを再実行する。

```console
gh run rerun RUN_ID --failed
```

`Re-run all jobs` は使わない。
Build job が同名 artifact の upload に失敗することで、再 build した別成果物の publish path への混入を防ぐ。
Artifact の retention を超えた場合は新しい patch release を作成する。

## Signing key rotation

1. 新しい公開鍵を `.github/release-keys/` に追加する Pull Request を作成する。
2. CODEOWNERS review と required checks を通して merge する。
3. 新しい鍵で test tag を local に作成し、`scripts/release/guard.sh` の local 検証を通す。
4. 次の release tag を新しい鍵で署名する。
5. 古い公開鍵は historical tag の検証に必要なため削除しない。

秘密鍵を repository、Actions secret、artifact に置いてはならない。
鍵の失効や端末喪失時も、tag ruleset を解除して unsigned tag を許可しない。

## Historical mutable releases

`v0.1.0` と `v0.1.1` は immutable releases の有効化前に公開されたため mutable である。
`.github/release-baselines.json` は tag commit と各 asset の name、size、digest を固定する。
[release-integrity.yml](../../.github/workflows/release-integrity.yml) は毎日 baseline との drift と tag signature を read-only で検証する。

Baseline を通常の release retry のために更新してはならない。
差分を検出した場合は公開を停止し、GitHub audit log と workflow history を確認した上で、新しい patch release で正しい成果物を配布する。

## npm package layout

Main package は `depatrol`、platform package は `@depatrol/cli-{darwin-arm64,darwin-x64,linux-x64,linux-arm64,win32-x64}` とする。
Platform package は `os` と `cpu` を宣言し、main package の `optionalDependencies` は同じ exact version に固定する。
Lifecycle script は使用しない。
CGO を無効にしているため musl variant は持たない。

既存 6 package は bootstrap 済みであり、現在は trusted publishing を使う。
新しい package を追加する場合だけ、短命な granular token で stub version を作成し、trusted publisher 登録後に token を失効させる。

## Homebrew

Homebrew は ADR 0006 の第 2 波であり、利用シグナル到達後に導入する。
導入時は `necofuryai/homebrew-tap` と GoReleaser `homebrew_casks` を使う。
未署名 cask の quarantine 回避は supply-chain 方針と衝突するため、Apple Developer Program による署名と notarization を優先して再評価する。
