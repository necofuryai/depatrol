# Release runbook

`v0.2.0` 以降のリリース運用手順を定める。
ツールチェーン移行は [ADR 0008](../decisions/0008-typescript-bun-stack.md)、単一バンドル npm パッケージ配布および build-once / immutable release の不変条件は [ADR 0009](../decisions/0009-single-npm-package-release.md) を正とする。
公開済み `v0.1.x` リリースは [ADR 0006](../decisions/0006-distribution.md) および [ADR 0007](../decisions/0007-build-once-immutable-release.md) の履歴として保持し、引き続き定期整合性検証の対象とする。
外部サービスの仕様は 2026-08-29 に確認した。
固定 version およびワークフロー構成は 2026-11-19 に確認した。

## Pipeline

Pull Request と `main` push では [ci.yml](../../.github/workflows/ci.yml) が次を実行する。

- `test` は `oven-sh/setup-bun`（`.bun-version`）と `actions/setup-node`（`.node-version`）を準備し、attestation 検証済みの `actionlint` を取得した上で、`bun install --frozen-lockfile --ignore-scripts`、`bun audit --audit-level=moderate`、および `scripts/ci/verify.sh` を実行する。
  `scripts/ci/verify.sh` は `package.json` / `bun.lock` ポリシー検証、`bun run typecheck`、`bun test`、`bun run build`、バンドルの `Bun.` / `bun:` 非混入および shebang 検証、Node.js と Bun 双方での `--version` 出力一致スモーク、`node --test scripts/release/*.test.mjs`、`actionlint` を順に検証する。
- `node-compat` は `main` ruleset の必須チェック名 `test` を matrix 化せず維持するため独立ジョブとし、Bun でビルドした `dist/depatrol.js` が `engines.node` 下限の Node.js 22 で動作すること、および `node --test scripts/release/*.test.mjs` が通ることを毎実行で確認する。
- `dependency-review` は Pull Request 専用で、`moderate` 以上の既知脆弱性の追加を拒否する。
- `release-preflight` は write permission と OIDC を持たず、`scripts/release/preflight.sh` により一時ディレクトリ（`mktemp -d`）上で `v0.0.0` の単一パッケージビルド（`build-package.mjs`）、release bundle 作成・検証（`artifacts.mjs create` / `verify`）、および npm dry-run（`publish-npm.mjs --dry-run --tag preflight`）を本番と同じ経路で検証する。

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
`release-validation` は publish permission を持たず、`bun audit`、`scripts/ci/verify.sh`、および `scripts/release/preflight.sh` を実行する。
`release-build` は `scripts/release/build-package.mjs` で単一バンドルと単一 npm tarball（`depatrol-<version>.tgz`）を一度だけ生成し、`scripts/release/notes.sh` と `scripts/release/artifacts.mjs create` で `release-bundle/` を構築した上で、`actions/attest` による provenance 付与と Actions artifact への upload を行う。
GitHub Release と npm は `release-${tag}-${commit}` という同じ Actions artifact を入力にし、再 pack を行わずに同一バイトの tarball を公開する。
Artifact は 30 日保持し、`overwrite: false` により同名 upload の上書きを禁止する。

次の tool は workflow 内の literal で固定する。
Local に読ませる専用 file がないため、operator が version を指定して有効化する。

| 対象 | version | 固定方法 |
|---|---:|---|
| npm CLI | `11.19.0` | `ci.yml` / `release.yml` 内の exact version（Renovate `custom.regex` で追従） |
| actionlint | `v1.7.12` | `ci.yml` / `release.yml` 内の `ACTIONLINT_VERSION`（`gh release download --repo rhysd/actionlint` と `gh attestation verify --repo rhysd/actionlint --source-ref refs/tags/$ACTIONLINT_VERSION --deny-self-hosted-runners` で検証取得、Renovate `custom.regex` で追従） |

次の tool は repository root の version file で固定する。
Toolchain と workflow がその file を直接読むため、更新時は file 側を正とする（確認済み version は本 runbook 見直し時の記録）。

| 対象 | 固定元 | 確認済み version | 取得方法 |
|---|---|---:|---|
| Bun | `.bun-version` | `1.4.4` | `oven-sh/setup-bun` の `bun-version-file`、local は `.bun-version` を読む toolchain manager |
| Node.js | `.node-version` | `24.22.3` | `actions/setup-node` の `node-version-file`、local は `.node-version` を読む toolchain manager |

`.node-version` の Node.js は CI・release を実行する側の pin であり、npm パッケージが利用者に要求する Node の下限（`package.json` の `engines.node`）とは別である。
下限は「npm package layout」に記録する。
`scripts/release/publish-npm.mjs` は OIDC trusted publishing の要件として npm `11.5.1` 以上を実行時に検証する。
表の npm CLI version（`11.19.0`）はこの下限を満たす exact version である。

Workflow で使う action は full commit SHA に固定する。

| action | tag | commit SHA |
|---|---|---|
| `actions/checkout` | `v7.0.1` | `3d3c42e5aac5ba805825da76410c181273ba90b1` |
| `oven-sh/setup-bun` | `v2.2.0` | `0c5077e51419868618aeaa5fe8019c62421857d6` |
| `actions/setup-node` | `v7.0.0` | `820762786026740c76f36085b0efc47a31fe5020` |
| `actions/dependency-review-action` | `v5.0.0` | `a1d282b36b6f3519aa1f3fc636f609c47dddb294` |
| `actions/attest` | `v4.2.2` | `1e69f48acb82d1966a394da916b4c1698aa569d6` |
| `actions/upload-artifact` | `v7.0.1` | `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a` |
| `actions/download-artifact` | `v8.0.1` | `3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c` |

## External configuration

Workflow を有効化する前に、repository と npm に次を設定する。

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
5. Actions policy allowlist は GitHub-owned actions と **`oven-sh/setup-bun`** だけを許可し、full SHA pinning を必須にする。
   `v0.1.x` で許可していた `goreleaser/goreleaser-action` は `v0.2.0` 移行に合わせて allowlist から外し、`oven-sh/setup-bun` へ切り替える。
6. Repository-level immutable releases を有効化する。
   この設定は新しい release にだけ適用され、既存 release は immutable にならない。
7. Administration read token で immutable releases endpoint の `enabled: true` を確認してから、repository variable `IMMUTABLE_RELEASES_ENABLED=true` を設定する。
   Release workflow の `GITHUB_TOKEN` には Administration read permission がないため、workflow から repository setting endpoint を直接確認しない。
   Repository variable は rollout 完了の fail-closed acknowledgement とし、公開後は release 自体の `isImmutable` を検証する。
8. GitHub environment `npm-release` を作成し、deployment branch and tag rule を `v*` に限定する。
9. npm の単一パッケージ `depatrol` で trusted publisher を `necofuryai/depatrol`、`release.yml`、environment `npm-release`、`npm publish` 許可として登録・維持する。
   Publishing access は traditional automation token 不許可（OIDC のみ）に強化した状態を維持する。

Dependency graph を無効のまま `dependency-review` を required にすると、導入 Pull Request 自体が失敗する。
必ず手順 1 を CI の required 化より先に実施する。

## Tag guard

`release-guard`（`scripts/release/guard.sh`）は次を全て検証する。

- Tag 名が `vMAJOR.MINOR.PATCH` と完全一致し、leading zero や prerelease suffix がない。
- Tag が lightweight tag ではなく annotated tag である。
- `.github/release-keys/` の公開鍵で tag signature を検証できる。
- GitHub Git Database API でも tag signature が `verified: true`、`reason: valid` である（`scripts/release/verify-remote-tag.sh`）。
- Tag commit が `.github/release-hardening-baseline` を最初に追加した commit 以後である。
- Tag commit が `origin/main` の祖先である。
- Push event の SHA と annotated tag が指す commit が一致する。

Tag commit と実行時点の `origin/main` tip の一致は要求しない。
Release 実行中に `main` が進んでも正しい release を失敗させないためである。
Operator の通常手順では、曖昧さを避けるため最新の green な `origin/main` に tag を付ける。

Hardening 導入前の commit には guard 自体が存在しない。
そのため tag ruleset と release operator の運用は trust boundary に残る。

## Release procedure

1. Release 対象を merge した Pull Request で `test`、`node-compat`、`dependency-review`、`release-preflight` が green だったことを確認する。
   `main` push では PR 専用の `dependency-review` は skip されるため、`main` 上では `test`、`node-compat`、`release-preflight` の成功を確認する。
2. Local の `main` を `origin/main` に fast-forward し、release 対象 commit を固定する。
3. `.bun-version`（`1.4.4`）の Bun、`.node-version`（`24.22.3`）の Node.js、表に記載した exact npm（`11.19.0`）および `actionlint`（`v1.7.12`）を有効にし、CI と同じ検証を local でも実行する。

   ```console
   bun install --frozen-lockfile --ignore-scripts
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
6. GitHub Release が immutable で、3 asset（`depatrol-X.Y.Z.tgz`、`checksums.txt`、`release-manifest.json`）の digest と attestation が検証できることを確認する。

   ```console
   gh release view vX.Y.Z --json tagName,isDraft,isImmutable,assets
   gh release verify vX.Y.Z --repo necofuryai/depatrol
   gh attestation verify depatrol-X.Y.Z.tgz \
     --repo necofuryai/depatrol \
     --signer-workflow necofuryai/depatrol/.github/workflows/release.yml \
     --source-ref refs/tags/vX.Y.Z
   ```

7. npm で単一パッケージ `depatrol@X.Y.Z` が公開され、provenance が付いており、レジストリの SRI が `release-manifest.json` の `integrity` と一致すること、および実コマンドで起動できることを確認する。

   ```console
   npm view depatrol@X.Y.Z dist.integrity
   npx depatrol@X.Y.Z --version
   ```

8. `v0.2.0` 初回公開後は、必要に応じて「npm package layout」の手順に従い、旧 `@depatrol/cli-*` パッケージへ npm deprecation 案内を付与する（任意）。

## Build artifact and manifest

`scripts/release/build-package.mjs` は次を一度だけ実行して単一 tarball を生成する。

- `bun build src/index.ts --target node --format esm --banner '#!/usr/bin/env node'` に `--define` で `__DEPATROL_VERSION__`、`__DEPATROL_COMMIT__`、`__DEPATROL_DATE__`（対象 commit の ISO-8601 commit date）を注入して `dist/depatrol.js` を生成する。
- 生成バンドルが単一の `#!/usr/bin/env node` で始まり、`Bun.` や `bun:*` 固有 API を含まないことを検証する。
- 公開用 `package.json`（`devDependencies`・`scripts`・`private` を除外し、実行時 `dependencies` / `optionalDependencies` / `peerDependencies` ゼロ、lifecycle スクリプト禁止、`engines.node` の bare major 下限 `>=22` を検証）をステージングする。
- `npm pack --json` で `depatrol-<version>.tgz` を生成し、同梱ファイルが allowlist（`LICENSE`、`README.md`、`dist/depatrol.js`、`package.json`）と完全一致すること、tarball バイト列の SHA-512 SRI が `npm pack` 出力と一致することを検証する。
- 生成した tarball を一時ディレクトリへ展開し、Node.js と Bun の双方で `dist/depatrol.js --version` の出力が埋め込みバージョン情報と完全一致することを確認する。

`scripts/release/artifacts.mjs` は `schemaVersion: 2` として、単一 tarball `depatrol-<version>.tgz`、`checksums.txt`、`release-notes.md`、`release-manifest.json` の 4 ファイルからなる `release-bundle/` を固定する（GitHub Release に添付する公開 asset は `depatrol-<version>.tgz`、`checksums.txt`、`release-manifest.json` の 3 ファイル）。
Manifest は `schemaVersion`、`repository`、`tag`、`commit`、各ファイルの `size` と `sha256:` digest、および `depatrol-<version>.tgz` の `sha512-...` SRI（`integrity`）を記録する。
作成直後、download 後、GitHub Release 公開前後、npm 公開前に同じ verifier（`artifacts.mjs verify` / `verify-release`）を実行する。

`actions/attest` は `release-bundle/*` の各ファイルに build provenance を付与する。
`release-build` には `id-token: write`、`attestations: write`、`artifact-metadata: write` が必要である。
Consumer job（`github-release`、`npm`）は `attestations: read` だけを持ち、`scripts/release/verify-attestations.sh` 経由の `gh attestation verify --deny-self-hosted-runners` で source repository、workflow、tag、commit を確認する。

## GitHub Release retry

| 状態 | 動作 |
|---|---|
| Release が存在しない | Bot が draft を作成し、全 asset（3 ファイル）を検証してから publish する。 |
| `github-actions[bot]` の draft が存在する | Draft を削除して元の Actions artifact から再作成する。 |
| 別 actor の draft が存在する | 自動削除せず停止し、operator が内容を確認する。 |
| 正しい immutable release が存在する | Asset と attestation を再検証し、成功済みとして終了する。 |
| Mutable release または digest 不一致 | 同じ tag を修復せず停止し、新しい patch release を要求する。 |

公開処理（`scripts/release/publish-github.sh`）は draft に `release-manifest.json` と manifest 記載の全 asset（`checksums.txt`、`depatrol-<version>.tgz`）を upload し、manifest と remote digest が一致してから publish する。
公開後に `isImmutable: true` にならなければ失敗する。
Draft は tag-name endpoint の取得対象外である。
公開前の検出には全ページを取得した Releases 一覧を使い、再検証と公開には一覧で確定した release ID を使う。
Draft の作成・削除直後だけは、一覧への反映を上限付き backoff で待つ。
API error、malformed response、duplicate、release ID、state、owner、tag の不一致は retry せず停止する。
公開済み release の `gh release verify` だけは例外とし、`no attestations for tag` を返す間を上限付き backoff で待つ。
GitHub は公開とほぼ同時に release attestation に署名するが、attestations API から取得できるまでに遅れることがある。
`gh` は attestations API の HTTP error と、attestation bundle の取得や解析の失敗も同じ表示にまとめるため、これらも同じ上限まで待つ。
この待機は read-only な検証を繰り返すだけなので、失敗を遅らせることはあっても、未検証の release を成功扱いにすることはない。
Tag の解決失敗を含め、`gh release verify` のそれ以外の失敗は待たずに停止する。
上限を超えて停止した場合は、公開済みの immutable release を `Re-run failed jobs` で再検証する。
再実行でも同じように停止する場合は、反映の遅れではなく attestations API の障害が考えられるため、再実行を重ねる前に原因を調べる。
Tag-name endpoint は、公開後に同じ release ID を返すことの検証にだけ使う。

## npm publish and retry

`npm` job は `release-build` と `github-release` の両方が成功した後に、Attestation 検証済みの `release-bundle/` をそのまま `scripts/release/publish-npm.mjs` へ渡す。
`publish-npm.mjs` は **公開時に再 pack しない**（Bun も使用しない）。

実行時に次を検証する。

1. `npm --version` が `11.5.1` 以上であること。
2. `artifacts.mjs` の `verifyBundle` が通ること。
3. ローカルの `depatrol-<version>.tgz` から計算した `sha512-...` SRI が `release-manifest.json` の `integrity` と完全一致すること。
4. Tarball 内の `package/package.json` が公開ポリシー（`version` 一致、実行時依存ゼロ、lifecycle スクリプトなし、`engines.node >= 22`、`scripts`/`devDependencies`/`private` 非含有）を満たすこと。

同じ version が npm registry に既に存在する場合は、`npm view depatrol@<version> dist.integrity` とローカル tarball の SRI が完全一致するときだけ skip 成功とする。
Version が存在しても SRI が異なる場合は publish せず fail-closed で停止し、新しい patch release を要求する。
未公開（`E404`）の場合のみ `npm publish <tarball> --access public` を実行する。

GitHub Release 成功後に `npm` だけが失敗した場合は、30 日以内に同じ workflow run の failed jobs だけを再実行する。

```console
gh run rerun RUN_ID --failed
```

`Re-run all jobs` は使わない。
`release-build` の `actions/upload-artifact` が `overwrite: false` により同名 artifact の再 upload を拒否することで、再ビルドした別成果物の publish path への混入を防ぐ。
Artifact の 30 日 retention を超えた場合は新しい patch release を作成する。

## Signing key rotation

1. 新しい公開鍵を `.github/release-keys/` に追加する Pull Request を作成する。
2. CODEOWNERS review と required checks を通して merge する。
3. 新しい鍵で test tag を local に作成し、`scripts/release/guard.sh` の local 検証を通す。
4. 次の release tag を新しい鍵で署名する。
5. 古い公開鍵は historical tag の検証に必要なため削除しない。

秘密鍵を repository、Actions secret、artifact に置いてはならない。
鍵の失効や端末喪失時も、tag ruleset を解除して unsigned tag を許可しない。

## Historical releases and integrity verification

`v0.1.0` と `v0.1.1` は immutable releases の有効化前に公開されたため mutable である。
`.github/release-baselines.json` はこれらの tag commit と各 asset の name、size、digest を固定する。

[release-integrity.yml](../../.github/workflows/release-integrity.yml) は毎日（および手動の `workflow_dispatch` で）`contents: read` 権限のまま `scripts/release/check-integrity.mjs .github/release-baselines.json` を実行し、過去世代と現行世代の双方を検証する。

- **baseline 登録済みリリース（`v0.1.0`、`v0.1.1`）**: `.github/release-baselines.json` の asset name・size・digest、および署名済み annotated tag の対象 commit との一致を検証する（`compareBaseline`）。
- **baseline 外の全公開安定リリース（ページネーション走査）**: `immutable: true`、署名済み annotated tag（`verified: true`, `reason: valid`）、全 asset の非ゼロ size と `sha256:` digest、および世代別期待アセット集合との一致を検証する（`compareImmutableRelease`）。
  - `v0.1.2`〜`v0.1.6`（`0.1.x` 世代）: 5 プラットフォームアーカイブ + `depatrol_<v>_checksums.txt` + `release-manifest.json` の 7 asset。
  - `v0.2.0` 以降: `depatrol-<v>.tgz` + `checksums.txt` + `release-manifest.json` の 3 asset。

`.github/release-baselines.json` を通常の release retry のために更新してはならない。
差分を検出した場合は公開を停止し、GitHub audit log と workflow history を確認した上で、新しい patch release で正しい成果物を配布する。

## npm package layout

`v0.2.0` 以降は単一パッケージ `depatrol` のみを公開する（[ADR 0009](../decisions/0009-single-npm-package-release.md)）。
同梱ファイルは allowlist（`LICENSE`、`README.md`、`dist/depatrol.js`、`package.json`）に厳格制限され、実行時 `dependencies`・`optionalDependencies`・`peerDependencies` はゼロ、lifecycle スクリプト（`preinstall` / `install` / `postinstall` 等）も一切持たない。
これにより `npx depatrol`、`bunx depatrol`、`pnpm dlx depatrol`、`npm install --ignore-scripts` のすべてで動作する。

`package.json` の `engines.node` は、nodejs/Release で maintenance が継続している最古の Node 系統を bare major 形式（`>=22`）で下限とする。
現在の下限は `>=22` であり、Node.js 22 の end-of-life は 2027-04-30 である。

`depatrol` は既に bootstrap 済みであり、OIDC trusted publishing を使用している。
将来新しい package を追加する場合だけ、短命な granular token で stub version を作成し、trusted publisher 登録後に token を失効させる。

### 旧 `@depatrol/cli-*` パッケージの扱い（`v0.2.0` 以降）

`v0.1.x` で配布していた 5 つのプラットフォーム別パッケージ（`@depatrol/cli-{darwin-arm64,darwin-x64,linux-x64,linux-arm64,win32-x64}`）は、`v0.2.0` 以降の新規 publish を停止する。
既存 `v0.1.x` 利用者のインストールを壊さないため旧版は unpublish せず残す。
`v0.2.0` の正常公開を確認した後、必要に応じてメンテナ権限で任意の npm deprecation 案内を付与できる。

```console
for pkg in darwin-arm64 darwin-x64 linux-x64 linux-arm64 win32-x64; do
  npm deprecate "@depatrol/cli-${pkg}@<0.2.0" \
    "depatrol v0.2.0+ ships as a single package without platform subpackages; install or run 'depatrol' directly."
done
```
