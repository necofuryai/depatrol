# depatrol

[English](README.md) | **日本語**

依存関係更新 bot のための read-only control plane。

depatrol は Dependabot と Renovate をリポジトリ横断で監視し、一つの問いに証跡付きで答える: **すべてのリポジトリは、依存関係の更新を実際に受け取り、取り込めているか?**

既存のツールは、bot が「設定されている」ことを確認する (OpenSSF Scorecard、Evergreen) か、open な alert を集計する (GitHub Security Overview、Dependency-Track)。しかし、次の点を bot 中立かつ継続的に検証するものはない:

1. すべてのリポジトリとすべての manifest が更新 bot にカバーされている
2. bot が組織の policy どおりに設定されている
3. スケジュールされた run が実際に実行されている (Dependabot は、PR が 90 日間触れられない、または run が 15 回失敗すると、静かに一時停止する)
4. 利用可能な修正のそれぞれに更新 PR が存在する、または作成できない理由が判明している
5. 停滞している PR の理由が説明されている (CI、merge conflict、review、rate limit、version constraint)
6. merge された修正が「現在の default branch 上で有効」である (revert されておらず、脆弱な version へ再解決されてもいない)
7. policy の SLA を超過した未修正の脆弱性が、判明している owner にエスカレーションされる

「設定ファイルが存在する」ことと「更新の仕組みが健全である」ことは同じではない。depatrol は、この二つの間にある隙間そのものを製品として扱う。

## ステータス

pre-alpha。最初のマイルストーン — read-only の GitHub credential でリポジトリをスキャンし、下記「リポジトリ rollup の語彙」の条件を報告する feasibility spike CLI (すべての判定には `confirmed` または `inferred` の印が付いた証跡の連鎖が伴う) — は **v0.1.0** として公開済みである ([インストール](#インストール) を参照)。

現時点の対象は GitHub 上の Dependabot である。Renovate (M1)、version update の default branch 再検証 (M2)、統治エンジン — policy、owner、例外、SLA (M3) — は未実装である。各マイルストーンで何が加わるかは [ROADMAP.md](ROADMAP.md) にある。domain model は確定している ([CONTEXT.md](CONTEXT.md) と [docs/decisions/](docs/decisions/) を参照)。実装言語は Go である (ADR 0002)。

## インストール

すべての配布チャネルは同一の git タグから出荷される (ADR 0006)。実行時には read-only の GitHub token が `GITHUB_TOKEN` (または `GH_TOKEN`) に必要である。

### npm — ツールチェーン不要

```console
npx depatrol scan --org your-org
```

`bunx depatrol` と `pnpm dlx depatrol` も同じように動く。このパッケージは `optionalDependencies` 経由でプラットフォーム別バイナリを解決し、install スクリプトを一切持たないため、`npm install --ignore-scripts` でも動作する。

`npm ci` が `Cannot find module @depatrol/cli-...` で失敗する場合、古い npm が他プラットフォームの optional 依存を落とした lockfile が原因である ([npm/cli#4828](https://github.com/npm/cli/issues/4828))。`package-lock.json` と `node_modules` を削除し、`npm install` をやり直すこと。

### go install

```console
go install github.com/necofuryai/depatrol@latest
```

### バイナリアーカイブ

[GitHub Releases](https://github.com/necofuryai/depatrol/releases) に darwin (arm64 / amd64)、linux (amd64 / arm64)、windows (amd64) のアーカイブと sha256 checksums がある。

## ドメインモデル

depatrol は二層のモデルを使う:

- **Finding (所見)**: 対象 (manifest、bot 設定、例外レコード) に付く、検証された観測。一つのリポジトリに複数の Finding が共存し、排他的な状態ではない。
- **ExpectedUpdate (期待更新) のライフサイクル**: 起きるべき更新の一つひとつを *ExpectedUpdate* (同一性は repository × manifest × dependency の組) として追跡し、PR がまだ存在するかどうかに関係なく、`pending → update_open → blocked ⇄ …` を経て、現在の default branch 上で `effective` と確認されるか、追跡が無意味になり `superseded` で終わるまで追う (merge 済みでも有効になっていなければ、`merged_not_effective` として追跡が続く)。PR や alert はこの entity に紐づく証跡であって entity 本体ではないため、PR の作り直しや grouped PR があっても追跡は途切れない。
- **Evidence (証跡)**: すべての判定は、根拠となった観測を引用する。各観測は `confirmed` (直接観測) か `inferred` (推定) のいずれかで、判定が `confirmed` になるのは、判定を支える観測のすべてが `confirmed` であるときに限る (最弱リンク則)。

製品の輪郭は、次の二つの線引きが定める:

- **depatrol は version 解決を自分では行わない** (ADR 0003)。検証するのは、bot が約束したことを実行しているかであって、可能なことをすべて約束したかではない。
- **depatrol はどこにも書き込まない** (ADR 0004)。policy、owner マッピング、例外は、組織自身の統治リポジトリに置く宣言的 YAML である。例外の承認は pull request の merge であり、監査証跡は git の履歴である。

## リポジトリ rollup の語彙

リポジトリ横断のビューでは、各リポジトリに、現存する条件のうち最も深刻なもののラベルを付ける (条件ごとの件数を併記する)。深刻度の高い順に:

| ラベル | 意味 |
|---|---|
| `sla_breached` | policy が定める対応期限を超過している (導出値) |
| `vulnerable_unpatched` | 未修正の脆弱性が現在の default branch に残っている (導出値) |
| `merged_not_effective` | merge 済みだが、現在の default branch の再評価では修正が有効になっていない |
| `fix_unavailable` | alert は存在するが、互換性のある修正版を作れない |
| `blocked` | 更新 PR が説明可能な理由 (CI、conflict、review、constraint) で停止している |
| `paused_or_stalled` | bot が一時停止しているか、期待した run が観測できない |
| `coverage_gap` | bot 設定も security feature も無い manifest がある |
| `policy_drift` | schedule、group、target branch が組織 policy から逸脱している |
| `update_open` | 更新 PR が処理待ち |
| `pending` | 更新は利用可能だが、まだ現在の default branch 上で有効になっていない。bot の PR 作成前と、merge 後に再評価で有効性が確定するまでの猶予の両方を含む (schedule / cooldown の範囲内なら正常) |
| `healthy` | Finding も未解決の ExpectedUpdate も無い (導出値) |

承認済みの例外が付いた条件は rollup から抑止される (記録には残る)。すべての条件が抑止されたリポジトリには `exception_active` が表示される。

この表は語彙の全体であって、現在の出力ではない。`policy_drift`、`sla_breached`、`exception_active` は統治エンジン (M3) を前提とするため、v0.1.0 では出力されない。

## 背景

このプロジェクトは、市場と競合の調査 (2026-08) を出発点とする。全文は [docs/research/2026-08-01-market-research.md](docs/research/2026-08-01-market-research.md) にある。

## コントリビューション

Issue フォーム、PR チェックリスト、ワークフロー全体 (trunk-based ブランチ、コミット規約、DCO) は [CONTRIBUTING.md](CONTRIBUTING.md) にある。脆弱性の報告は public な Issue ではなく、リポジトリの Security タブから private に行うこと。

## ライセンス

Apache-2.0。コントリビューションには DCO の sign-off (`git commit -s`) が必要である。
