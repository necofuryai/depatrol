# 依存関係更新オーケストレーターの需要と競合調査

- 調査基準日：2026-08-01
- 対象：Dependabot、Renovate などの依存関係更新 bot をリポジトリ横断で監視する OSS
- 想定利用者：Platform Engineering、AppSec、OSPO、開発基盤チーム
- 調査方法：公式ドキュメント、公式リポジトリ、公開 Issue、および `necofuryai/necofuryai.dev` の GitHub API を確認

## 結論

需要はある。

ただし、単なる「古い依存関係と脆弱性の一覧」では既存製品との差が弱い。

GitHub Security Overview、Mend Developer Platform、OWASP Dependency-Track、DefectDojo は、脆弱性の横断集約や優先順位付けをすでに提供している。

Renovate の Dependency Dashboard、`gh-dep`、Ampel などは、更新候補や Pull Request の処理を部分的に可視化している。

一方で、Dependabot と Renovate を同じ状態モデルで扱い、設定の有無、予定どおりの稼働、Pull Request の停滞理由、現在の default branch への修正到達、セキュリティー SLA 違反までを一つの証跡として追う OSS は、今回の調査では確認できなかった。

したがって、作るなら「依存関係スキャナー」や「新しい更新 bot」ではなく、既存 bot の実行信頼性と修正到達を検証する read-only の control plane に絞るべきである。

最初の市場仮説は、50 以上のリポジトリを持ち、Dependabot または Renovate を運用している GitHub 組織とする。

これは需要規模が確認済みという意味ではなく、問題が発生しやすく、既存の GitHub 画面やリポジトリ単位の Dashboard だけでは運用が分散しやすい層としての仮説である。

## 需要を示す根拠

### 1. OpenSSF が未解決範囲を明記している

[OpenSSF Scorecard の Dependency-Update-Tool check](https://github.com/ossf/scorecard/blob/main/docs/checks.md#dependency-update-tool) は、Dependabot または Renovate が有効かを検出する。

同じ文書は、検出できるのは有効化までであり、ツールが実際に実行されたか、作成された Pull Request がマージされたかは保証しないと明記している。

これは、提案するツールが埋めるべき空白を一次資料が直接示したものといえる。

### 2. GitHub 自身が横断導入のために Evergreen を作った

GitHub の OSPO は、リポジトリごとの `dependabot.yml` による設定分散を課題とし、Dependabot の導入状況を組織横断で確認する [Evergreen](https://github.com/github-community-projects/evergreen) を作った。

[GitHub の解説](https://github.blog/security/supply-chain-security/do-you-know-if-all-your-repositories-have-up-to-date-dependencies/) では、全リポジトリの依存関係を追跡することは困難であり、GitHub 内でも Dependabot を有効にすべき非公開リポジトリを数百件特定したとしている。

Evergreen は導入漏れを埋めるが、導入後の実行、Pull Request、default branch への到達までは追跡しない。

### 3. 大規模 Renovate 利用者は監視基盤を内製している

[Swissquote の Renovate 事例](https://docs.renovatebot.com/user-stories/swissquote/) では、約 2,000 の active repository のうち 857 リポジトリで Renovate を有効化していた。

同社は、Renovate OSS を順番に実行するだけでは一巡に数時間かかり、リポジトリごとのログ確認も難しかったため、独自 scheduler、ログ分離、InfluxDB、Grafana による監視を構築した。

収集している値には、run の時間と成否、作成、更新、マージ、クローズされた Pull Request 数が含まれる。

単一事例では市場規模を証明できないが、一定規模を超えると更新 bot 自体の運用監視が独立した問題になることを示している。

### 4. 組織横断 Dashboard の要望が継続している

[dependabot-core issue #2936](https://github.com/dependabot/dependabot-core/issues/2936) は、組織内の全リポジトリについて Dependabot の設定と更新状況を確認したいという要望である。

2026-08-01 時点で open のままで、59 reactions と 24 comments が付いている。

GitHub Security Overview により脆弱性アラートの集約は進んだが、通常の version update、設定差分、実行履歴、更新 Pull Request の処理状況を bot 横断で扱う要求は残る。

### 5. Dependabot は有効でも停止し得る

[GitHub の自動停止仕様](https://docs.github.com/en/code-security/reference/supply-chain-security/troubleshoot-dependabot/dependabot-updates-stopped) では、90 日を超えて未処理の Dependabot Pull Request があり、人による操作がないリポジトリでは version update と security update が一時停止する。

停止状態は repository の Pull Request、Settings、Dependabot alerts などに表示されるため、リポジトリ数が増えるほど見落としやすい。

また GitHub は、[scheduled job が 15 回連続で失敗すると一時停止する仕様](https://github.blog/changelog/2024-03-15-dependabot-will-now-pause-scheduled-jobs-after-15-failures/) も案内している。

「設定ファイルが存在する」ことと「更新機構が健全に動いている」ことは同義ではない。

## このリポジトリの現状

`necofuryai/necofuryai.dev` は、2026-08-01 時点では正常系のサンプルとして扱える。

- default branch は `main` である。
- [`.github/dependabot.yml`](https://github.com/necofuryai/necofuryai.dev/blob/main/.github/dependabot.yml) は、npm を毎週、GitHub Actions を毎日確認する。
- Dependabot security updates は `enabled: true`、`paused: false` である。
- open の Dependabot alert は 0 件である。
- open の Dependabot Pull Request は 0 件である。
- 2026-07-01 以降、Dependabot が作成し `main` にマージされた Pull Request は 22 件である。
- 最新の [Pull Request #83](https://github.com/necofuryai/necofuryai.dev/pull/83) の merge commit は、2026-08-01 時点の `main` HEAD の祖先である。

この確認には、設定ファイル、security update の有効状態、alert、Pull Request、default branch の commit 到達を別々に照合する必要があった。

提案するツールの価値は、この手作業を多数のリポジトリについて継続的に行い、正常系も含めて同じ証跡で説明できることにある。

## 既存ツールの比較

| ツール | 提供形態 | 横断管理できる範囲 | 提案との主な差分 |
|---|---|---|---|
| [GitHub Security Overview と Dependabot REST API](https://docs.github.com/en/enterprise-cloud@latest/code-security/concepts/security-at-scale/security-overview) | GitHub の機能 | 組織または enterprise の Dependabot alerts、severity、EPSS、patch availability、修正傾向、repository 内訳 | 脆弱性管理は強いが、Renovate を扱わず、通常の version update、bot run、Pull Request の停滞から現行 default branch への到達までを一つの lifecycle として扱わない |
| [GitHub Evergreen](https://github.com/github-community-projects/evergreen) | OSS、MIT | 組織、team、指定 repository で Dependabot の設定漏れや ecosystem 漏れを検出し、Issue または Pull Request を作成 | 導入と設定の一貫性が中心で、導入後の稼働、Pull Request、脆弱性 SLA は対象外 |
| [`gh-dep`](https://github.com/jackchuka/gh-dep) | OSS、MIT | Dependabot と Renovate の Pull Request を複数 repository から収集し、CI 状態を見ながら approve または merge | 最も近い操作系だが、open Pull Request の処理が中心で、bot の実行履歴、脆弱性、default branch 上の解消状態、SLA の履歴を持たない |
| [DashGit](https://github.com/javiertuya/dashgit) | OSS、MIT | GitHub と GitLab の複数 repository、build status、Dependabot update をブラウザーで集約し、repository ごとのまとめ Pull Request と merge を支援 | 最も近い GUI だが Dependabot 中心で、bot run、security alert、SLA、merge 後の default branch 再評価は対象外 |
| [repo-guardian](https://github.com/donaldgifford/repo-guardian) | OSS、Apache-2.0 | GitHub App が組織または複数組織を定期 reconcile し、Dependabot、Renovate、CODEOWNERS などの file policy drift を検出して修正 Pull Request を作成 | 設定の存在と内容準拠には近いが、bot の実行、更新 Pull Request、脆弱性、SLA、default branch 上の解消は追跡しない |
| [Renovate OSS と Dependency Dashboard](https://docs.renovatebot.com/key-concepts/dashboard/) | OSS、AGPL-3.0 | autodiscover と共通 preset で複数 repository を更新し、各 repository の Issue に pending、closed、ignored などを表示 | 更新 engine と repository 単位の Dashboard であり、Dependabot を含む組織横断 control plane ではない |
| [Renovate Operator](https://github.com/mogenius/renovate-operator) | OSS、MIT | Kubernetes 上の Renovate 実行、project status、run、ログ、Prometheus metrics、Pull Request activity | Renovate と Kubernetes に限定され、Dependabot alert、bot 横断 SLA、default branch 上の修正確認は対象外 |
| [Mend Developer Platform と Renovate CE/EE](https://docs.renovatebot.com/getting-started/running/#mend-renovate-self-hosted-community-edition-enterprise-edition) | hosted または closed source | installed repository、engine status、job、ログ、queue、Renovate update を集約 | Renovate と Mend の製品内では強い競合だが、bot neutral な OSS ではない |
| [OWASP Dependency-Track](https://github.com/DependencyTrack/dependency-track) | OSS、Apache-2.0 | SBOM を基に component、脆弱性、policy、EPSS、監査、通知を portfolio 単位で管理 | vulnerability intelligence と inventory が中心で、更新 bot の設定、run、Pull Request、default branch 到達を管理しない |
| [DefectDojo](https://github.com/DefectDojo/django-DefectDojo) | OSS、BSD-3-Clause | scanner finding の集約、severity 基準の SLA countdown、breach の filter と通知、GitHub vulnerability alert の import | [GitHub parser](https://github.com/DefectDojo/django-DefectDojo/blob/master/docs/content/supported_tools/parsers/file/github_vulnerability.md) は Dependabot update の Pull Request も任意で取り込めるが、通常の version update、bot run、設定 drift、default branch 到達は管理しない |
| [OSV-Scanner](https://github.com/google/osv-scanner) | OSS、Apache-2.0 | source、lockfile、container、SBOM の脆弱性を走査し、JSON や SARIF を出力 | 検出器として有用だが、継続的な repository 横断 lifecycle と責任者、SLA を保持しない |
| [GUAC](https://github.com/guacsec/guac) | OSS、Apache-2.0 | SBOM と supply-chain metadata を graph に集約し、OSV や Scorecard の情報を関連付ける | data layer と query 基盤であり、更新 bot の運用を判定する opinionated な UI と policy engine ではない |

GitHub の [Dependabot alert metrics](https://docs.github.com/en/code-security/concepts/supply-chain-security/dependabot-alert-metrics) は、severity だけでなく、EPSS、direct または transitive、runtime または development、patch availability を使った優先順位付けまで提供する。

そのため、新しい OSS が severity 別の alert 一覧だけを作っても差別化になりにくい。

[GitHub security campaigns](https://docs.github.com/en/code-security/how-tos/manage-security-alerts/remediate-alerts-at-scale/creating-managing-security-campaigns) は 2026-08-01 時点で code scanning と secret scanning を対象としており、Dependabot alert を remediation campaign として扱う機能は確認できなかった。

[DefectDojo の SLA 文書](https://docs.defectdojo.com/asset_modelling/os_hierarchy/os__sla_configuration/) では、OSS でも severity 基準の Finding SLA、期限超過、filter、通知を利用できる。

複数 SLA configuration の管理、Product ごとの選択適用、SLA dashboard は Pro と明記されているため、OSS 版の範囲と混同してはならない。

なお、[`mend/renovate-ce-ee`](https://github.com/mend/renovate-ce-ee) は公開リポジトリだが、公開されているのは文書、release note、example である。

Renovate 公式文書は CE と EE を closed-source offering と明記しており、container の利用は Mend の Terms of Service と license key に従うため、OSS 競合として数えてはならない。

## 小規模または部分的に近い OSS

### Ampel

[Ampel](https://github.com/pacphi/ampel) は、GitHub、GitLab、Bitbucket の Pull Request と CI 状態を一つの画面に集約する MIT License の self-hosted dashboard である。

bot 判定と auto-merge rule の構造もあるが、[公開されている実装状況](https://github.com/pacphi/ampel/blob/main/docs/planning/PRODUCT_SPEC.md#bot-filtering) では bot filtering は partial、専用 UI は未実装、auto-merge worker も未実装である。

一般的な Pull Request control plane として隣接するが、脆弱性と更新 bot の lifecycle を中心に設計した製品ではない。

### Renovate PR visualization

[Renovate PR visualization](https://github.com/MShekow/renovate-pr-visualization) は、複数 repository の Renovate onboarding 状態、open Pull Request 数、close までの時間を PostgreSQL と Metabase で可視化する MIT License の OSS である。

Renovate の技術的負債推移を見る用途には近いが、Dependabot、bot run の成否、脆弱性 SLA、現在の default branch 上の解消確認は扱わない。

### Dependabot-Dashboard

[Dependabot-Dashboard](https://github.com/0xbadshah/Dependabot-Dashboard) は、GitHub organization と repository の Dependabot alerts を PostgreSQL に保存する小さな実装である。

2026-08-01 時点で repository は archived であり、GitHub Enterprise Server 以外では未検証とされている。

これは alert の時系列保存需要を示すが、現在の基盤候補にはしない。

## 空いている領域

競合が薄いのは、次の一連の状態を bot neutral に結び付ける部分である。

1. 対象 repository と manifest が inventory に入っている。
2. Dependabot または Renovate が policy どおりに設定されている。
3. 予定した run が実行され、成功または説明可能な失敗として記録されている。
4. 利用可能な更新または修正版に対応する Pull Request が存在するか、作れない理由が分かる。
5. Pull Request が CI、conflict、review、rate limit、version constraint のどこで止まっているか分かる。
6. merge 済みというイベントだけでなく、現在の default branch が安全な解決 version を含むことを確認できる。
7. 未修正の脆弱性が policy で定めた期限を超えた場合、owner と例外理由を含めて通知できる。

特に 6 が差別化の中心になる。

Pull Request の `merged_at` だけでは、その Pull Request が default branch 以外を対象にしていた、後で revert された、lockfile の解決結果が再び脆弱な version に戻った、といった状態を除外できない。

「修正済み」は、現在の default branch の manifest または lockfile と vulnerability source を再評価して判定すべきである。

## 推奨 MVP

### 対象範囲

最初は GitHub Cloud の read-only GitHub App に限定する。

Dependabot と Renovate の両方を adapter で扱うが、GitLab、Bitbucket、Azure DevOps は初期対象にしない。

更新 Pull Request の自動マージ、設定ファイルの自動修正、alert の自動 dismiss は初期対象にしない。

これらは権限と誤操作のリスクを増やし、観測と判定の価値検証を遅らせるためである。

### 最小機能

1. organization、repository、default branch、manifest、bot config を inventory 化する。
2. Dependabot security updates の `enabled` と `paused`、Renovate の onboarding と run status を正規化する。
3. bot author、label、branch prefix、Pull Request body の metadata を adapter ごとに解釈する。
4. open Pull Request の age、CI、merge conflict、review、target branch を収集する。
5. Dependabot REST API、または OSV-Scanner などの scanner adapter から脆弱性を収集する。
6. merge commit の到達と、current default branch の manifest または lockfile の再走査を照合する。
7. repository owner、severity、EPSS、patch availability、dependency scope、repository criticality による SLA を判定する。
8. JSON、Prometheus metrics、簡潔な Web UI で状態と根拠を表示する。

初期状態モデルは次で足りる。

| 状態 | 意味 |
|---|---|
| `healthy` | policy に合致し、未処理の異常がない |
| `coverage_gap` | manifest に対する bot 設定または security feature がない |
| `policy_drift` | schedule、group、target branch などが組織 policy と異なる |
| `paused_or_stalled` | bot が paused、または期待した run が観測できない |
| `update_open` | 更新 Pull Request が処理待ち |
| `blocked` | CI、conflict、review、constraint など明示できる理由で停止 |
| `fix_unavailable` | alert はあるが互換性のある修正版を作れない |
| `merged_not_effective` | merge 済みだが current default branch の再評価では更新または修正が有効でない |
| `vulnerable_unpatched` | current default branch に未修正の脆弱性が残る |
| `exception_active` | owner、理由、期限を持つ承認済み例外 |
| `sla_breached` | policy で定めた対応期限を超過 |

### 優先順位付け

緊急度を severity だけで決めてはならない。

GitHub の現行 metrics と同様に、少なくとも severity、EPSS、patch availability、direct または transitive、runtime または development を組み合わせる。

さらに repository の business criticality、internet exposure、owner、例外期限を組織側の policy として追加する。

SLA の日数は OSS 側で固定せず、repository class と risk 条件に応じて設定可能にする。

### データ取得上の注意

[Dependabot alert REST API](https://docs.github.com/en/rest/dependabot/alerts) は organization と repository の alert を取得でき、`created_at`、`fixed_at`、severity、EPSS、patched version などを提供する。

[Dependabot security updates の状態 API](https://docs.github.com/en/rest/repos/repos#check-if-dependabot-security-updates-are-enabled-for-a-repository) は `enabled` と `paused` を返す。

[Dependabot job logs](https://docs.github.com/en/code-security/concepts/supply-chain-security/dependabot-job-logs) は run の timestamp、type、関連 Pull Request、error を保持するが、今回確認した公式文書では organization 横断で取得する公開 API を確認できなかった。

したがって、Dependabot version update の「最終成功 run」を正確に取得できるかは、実装前の feasibility spike とする。

取得できない場合は、config schedule、paused state、Pull Request activity、alert、repository event を組み合わせた推定値とし、`confirmed` と `inferred` を UI で区別する必要がある。

Renovate は self-hosted identity を任意に変更できるため、`renovate[bot]` という login だけに依存してはならない。

adapter ごとに GitHub App ID、login、label、branch prefix、Pull Request body の識別規則を設定できるようにする。

## 需要検証の進め方

実装前に、Platform Engineering、AppSec、OSPO の担当者 10 から 15 人へ interview する。

対象は、50 以上の repository、Dependabot または Renovate、security alert の対応期限、複数 team の owner 管理のうち二つ以上を持つ組織を優先する。

次の質問で、一般的な「便利そう」ではなく、現在発生している手作業と損失を確認する。

- bot が止まっていたことを最後に見つけたのはいつか。
- 全 repository の設定差分と paused state をどう確認しているか。
- security alert から修正 Pull Request、merge、default branch 上の解消までをどう証明しているか。
- 対応期限を超えた alert を誰に通知し、例外をどこに記録しているか。
- GitHub Security Overview、Mend、Dependency-Track、DefectDojo で足りない情報は何か。
- 現在の監視 script、spreadsheet、Grafana、Slack bot を置き換える条件は何か。

3 組織以上が匿名化した repository state を提供できるなら、4 週間の read-only pilot に進む。

pilot では、既存 dashboard が見逃していた `coverage_gap`、`paused_or_stalled`、`blocked`、`merged_not_effective`、`sla_breached` を何件検出し、そのうち何件が実際に修正されたかを測る。

利用者が必要としているのが alert の一覧だけなら中止する。

その用途は GitHub Security Overview、Dependency-Track、DefectDojo がすでに強い。

利用者が必要としているのが Pull Request の一括処理だけなら、`gh-dep` または Ampel への contribution を先に検討する。

### Go または no-go の判定

次の基準は市場の事実ではなく、pilot 開始前に合意する検証基準の案である。

| 判定 | 条件 |
|---|---|
| Go | 3 組織以上が design partner となり、既存手段では見落としていた actionable な状態を pilot 中に検出でき、owner が実際に修正または例外登録へ動く |
| Pivot | 課題は確認できるが、価値が config drift、Pull Request 処理、vulnerability SLA の一領域だけに集中する |
| No-go | alert 一覧または一括 merge で要求が満たされる、匿名化した実データを提供する partner が集まらない、または Dependabot の run evidence を十分な精度で取得できず中核の判定を説明できない |

Pivot の場合は新しい総合製品を続けず、repo-guardian、`gh-dep`、DefectDojo など、該当領域の既存 OSS への contribution を優先する。

## 最終判断

OSS として試作する価値はある。

ただし、最初から「すべての forge、すべての package manager、すべての scanner を統合する」構想にすると、既存製品の薄い再実装になりやすい。

最初の release は GitHub、Dependabot、Renovate、read-only、default branch 到達確認、SLA 違反の五点に限定する。

この範囲で利用者が見落としていた実害のある状態を継続的に発見できれば、OSS の独立した価値が成立する。

発見できなければ、新規製品ではなく `gh-dep`、Renovate Operator、DefectDojo などへの機能追加に切り替えるのが妥当である。

## 追加検証と補遺 (2026-08-01)

本節は、GitHub API、各公式ドキュメント、Web 検索を用いて上記の調査結果を再検証し、未掲載の競合と市場文脈を補った記録である。

再検証の結果、本文の事実主張 (このリポジトリの現状、既存ツール表の各項目、GitHub の停止仕様と API、OpenSSF Scorecard と Swissquote の記述) はすべて一次情報と一致した。

### 本文への補足

GitHub Security Overview の Dependabot ビューは有料機能である。

[提供条件](https://docs.github.com/en/code-security/concepts/security-at-scale/security-overview) では、GitHub Enterprise の組織は Dependabot データを利用できるが、Team プランでは GitHub Code Security または GitHub Secret Protection の購入が必要で、Free には提供されない。

無償プランの組織には GitHub 純正の横断ビューが存在しないため、read-only OSS の対象層として明記できる。

比較表のツールのうち、Renovate PR visualization は 2024-07-22 を最後に更新が止まっており、repo-guardian は star 2 の初期実装である。

この 2 件については、競合としての実勢は表の記述より弱い。

### 未掲載だった OSS

「空いている領域」に挙げた一連の状態のうち、いくつかは単体の OSS 実装がすでに存在する。

| ツール | 提供形態 | カバーする状態 | 提案との主な差分 |
|---|---|---|---|
| [dependency-management-data](https://gitlab.com/tanna.dev/dependency-management-data) (DMD) | OSS、Apache-2.0。2026-07-29 更新の活発なプロジェクト | renovate-graph と SBOM (CycloneDX、SPDX) から現在の default branch の依存スナップショットを取り込み、CVE と EOL の advisory、OPA/Rego の policy、Web UI と GraphQL を提供 | 状態 6 (default branch の再評価) を advisory 照合として先行実装している。bot の run、paused 状態、Pull Request の停滞、時間ベースの SLA は持たない |
| [Watchtower](https://github.com/lalitindoria/watchtower) | OSS、Apache-2.0 | Dependabot alert の severity 別 SLA、Slack 通知とエスカレーション、SLA 超過者への merge gate を GitHub Actions のみで提供 | `sla_breached` の Dependabot 版が単体で存在する。Renovate、version update、run、default branch 再評価は対象外 |
| [Krabbx](https://github.com/banshee86vr/krabbx) | 公開ソースだがライセンス未設定。2025-12 開始 | GitHub 組織横断の Renovate 導入状況と open Pull Request の self-hosted ダッシュボード | `coverage_gap` と `update_open` の Renovate 版。Dependabot、run、SLA は対象外 |
| [renovate-metrics](https://github.com/raffis/renovate-metrics) ほか exporter 群 | OSS | self-hosted Renovate の debug ログから run の成否と最終成功時刻を Prometheus metrics 化し、Grafana ダッシュボードを同梱 | `paused_or_stalled` の Renovate self-hosted 版。同種の単機能 exporter は 2023 年以降少なくとも 6 個 (raffis、gjed、martin-viggiano、segfault-labs、yuya-takeyama、CyberHippo) が独立に作られている |
| [lazyreno](https://github.com/limehawk/lazyreno) | OSS、MIT | Renovate CE の全リポジトリの Pull Request と job queue を TUI で一括操作 | `gh-dep` と同系の操作層で、Renovate CE 専用 |
| [@secustor/backstage-plugin-renovate](https://github.com/secustor/backstage-plugins) | OSS、LGPL-3.0 | Backstage 内で組織規模の Renovate report を閲覧、再実行 | Backstage 前提で Renovate のみ |

最大の見落としは DMD である。

本文は状態 6 (現在の default branch の再評価) を差別化の中心としたが、その再評価自体は DMD が advisory 照合としてすでに提供しており、単独では新規性を主張できない。

一方で DMD は bot の実行、Pull Request、SLA を扱わないため、提案全体の反証にはならず、むしろインベントリと advisory 照合のデータ層として再利用または連携する候補になる。

### 未掲載だった商用カテゴリー

本文の比較は GitHub 純正、OSS、Mend に限られているが、隣接する商用カテゴリーが二つある。

一つ目は **ASPM** (Application Security Posture Management) で、Apiiro、Legit Security、Cycode、Arnica、OX Security などが脆弱性の横断集約と修復 SLA の追跡を提供している。

[Snyk の SLA Management report](https://updates.snyk.io/introducing-sla-management-featured-zero-day-reports-292394/) も、SLA を within、at-risk、breached に区分して組織横断で表示する。

したがって `sla_breached` は、alert 起点に限れば商用では解決済みであり、OSS 側の差別化は SLA 単体ではなく bot の実行証跡との結合に置く必要がある。

二つ目は **IDP** (Internal Developer Portal) で、Port、Cortex、OpsLevel、Backstage (Soundcheck、Roadie plugin) が Dependabot alert をリポジトリ単位のスコアカードに取り込む。

どちらのカテゴリーも、bot の run、Pull Request の停滞、default branch 到達の証跡は扱わない。

### GitHub 自身による侵食リスク

GitHub は 2026 年に入って Dependabot 関連機能を続けて出荷している。

org-level Dependabot metrics の GA (2026-01。GHES 3.19 にも搭載)、alert assignees の GA (2026-03)、[AI エージェントへの alert 割り当てと修正 draft Pull Request](https://github.blog/changelog/2026-04-07-dependabot-alerts-are-now-assignable-to-ai-agents-for-remediation/) (2026-04)、dependabot.yml 変更の監査ログ (2026-02) である。

alert の可視化と修復の所有権は、プラットフォーム側が埋めつつある。

一方で、run の観測 (organization 横断の job log API は依然として確認できない)、version update Pull Request の停滞、Renovate 対応には、2026-08-01 時点で着手の形跡がない。

侵食が及んでいないのは本文の「空いている領域」と重なるため、買い手仮説は GHAS 系 add-on を購入していない組織と、Dependabot と Renovate が混在する組織へ絞るとより整合的になる。

### 需要の追加根拠

[renovate discussion #25906](https://github.com/renovatebot/renovate/discussions/25906) では、self-hosted Renovate の監視方法を問われたメンテナーが、組み込みの監視はなく JSON ログと OpenTelemetry で自作するよう答えている。

前掲の exporter 群が 0 から 1 star の規模で繰り返し再発明されていることも、断片への需要が続いている証拠になる。

### 検証後の結論

中心の結論 (Dependabot と Renovate を同じ状態モデルで扱い、設定から SLA までを一つの証跡で追う OSS は存在しない) は、追加探索の後も維持できる。

ただし差別化の主張は言い直しが要る。

SLA は Watchtower と ASPM が、default branch 再評価は DMD が、run 監視は exporter 群が、導入監視は Evergreen と Krabbx が、それぞれ単体で部分的に占めている。

空いているのは個々の状態ではなく、bot 中立で全状態を一つの証跡に結ぶ統合である。

MVP の設計には次の 2 点を加える。

- feasibility spike に、DMD をデータ層として利用または連携する検討を含める。
- 停滞判定は schedule の額面ではなく cooldown を考慮する。実際にこのリポジトリの `dependabot.yml` も npm weekly に 3 から 14 日の cooldown を併用しており、額面の schedule だけで判定すると正常なリポジトリを停滞と誤判定する。
