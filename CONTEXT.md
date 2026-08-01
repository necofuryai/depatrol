# depatrol

Dependabot / Renovate をリポジトリ横断で監視する read-only control plane の domain glossary。用語が確定するたびに更新する。実装詳細は書かない (それは ADR と spec の領分)。

## Language

**Finding (所見)**:
特定の対象 (manifest、bot 設定、Pull Request、alert など) に証跡付きで付く、検証された観測。一つのリポジトリに複数の Finding が同時に存在しうる。排他的ではない。
_Avoid_: この意味で「状態 (state)」を使うこと (state はライフサイクルの遷移位置を指す)。

**Rollup (状態集約)**:
リポジトリに現存する条件 (Finding とライフサイクル状態) のうち最も深刻な一つを表示語彙のラベルとして付け、条件ごとの件数を併記する導出値。深刻度順: sla_breached > vulnerable_unpatched > merged_not_effective > fix_unavailable > blocked > paused_or_stalled > coverage_gap > policy_drift > update_open > pending > healthy。
_Avoid_: rollup を一次データとして扱う表現。

**表示語彙 (published vocabulary)**:
rollup に使う対外的なラベルの集合 (従来の「11 状態表」の再解釈)。内部モデル (二層 + Evidence) とは意図的に分離された外向きの言語。

**抑止 (suppression)**:
例外 (exception) が付いた条件を rollup の計算から除外する作用。記録は残る。リポジトリの全条件が抑止されたときのみ rollup は `exception_active` になる。
_Avoid_: 例外による条件の削除・非表示という表現 (記録は消えない)。

**healthy**:
「Finding が一つもない」ことの導出結果。11 番目の対等な状態ではなく、記録される Finding でもない。

**ExpectedUpdate (期待更新)**:
「依存 X を現在の version から安全な/新しい version へ動かすべきである」という事実そのものを表す entity。同一性は (repository, manifest, dependency) の組。PR や alert はこの entity に紐づく証跡であり、entity 本体ではない。PR が未作成・作成不能・作り直しでもライフサイクルは途切れない。advisory への参照を持つものが security fix、持たないものが通常の version update。
_Avoid_: Remediation (security 専用に聞こえる)、素の Update (GitHub API 用語と衝突)。

**ライフサイクル (lifecycle)**:
一つの ExpectedUpdate が「利用可能になってから、現在の default branch 上で有効と確認されるまで」に辿る状態遷移。Finding 分類法と並ぶ二層モデルのもう一層。
_Avoid_: この意味で「Finding」を使うこと。

**実体化 (materialization)**:
ExpectedUpdate が観測によって生まれること。情報源は security alert、bot 自身の出力 (PR、Renovate Dependency Dashboard issue)、scanner adapter の三系統に限る。depatrol 自身は version 解決を行わない (ADR 0003)。
_Avoid_: depatrol が registry を照会して「利用可能な更新」を自力で発見するという表現。

**Evidence (証跡)**:
第一級の記録対象となる個々の観測 (API レスポンス、PR、alert、commit 祖先判定、Dashboard issue の解析結果)。出所 (provenance) と確度を持つ。Finding とライフサイクル状態は Evidence への参照の集合を持つ判定であり、Evidence そのものではない。

**確度 (confidence)**:
Evidence と判定が持つ二値の属性。`confirmed` は直接観測、`inferred` は推定。数値スコアは使わない。

**最弱リンク則 (weakest-link rule)**:
判定の確度の導出規則。判定を支える Evidence が一つでも `inferred` なら、判定全体の確度も `inferred` になる。多数決や昇格は無い。

**統治オブジェクト (governance object)**:
policy、owner マッピング、例外の総称。組織の統治リポジトリに git 管理の宣言的 YAML として置かれ、depatrol はそれを読むだけで一切書かない (ADR 0004)。
_Avoid_: depatrol の UI や API で統治オブジェクトを作成・編集するという表現。

**Policy (組織 policy)**:
bot 設定のあるべき姿 (schedule、group、target branch など) と SLA の対応期限を定める統治オブジェクト。`policy_drift` と `sla_breached` の判定基準。

**Owner**:
Finding とエスカレーションの通知先となる責任者。統治ファイルのマッピングを優先し、無ければ CODEOWNERS にフォールバックして解決する。

**例外 (exception)**:
owner、理由、期限を持つ承認済みの統治オブジェクト。承認は統治リポジトリへの PR merge で行われ、対象の条件に抑止として作用する。
_Avoid_: 期限や owner の無い恒久 mute。

### ライフサイクル状態 (ExpectedUpdate の遷移位置)

**pending**:
更新は利用可能だが、bot がまだ PR を作っていない期間。schedule や cooldown の範囲内なら正常。

**update_open**:
ExpectedUpdate に対応する PR が存在し、正常に処理待ち。

**blocked**:
PR が説明可能な理由 (CI、merge conflict、review、rate limit、version constraint) で停止している。

**fix_unavailable**:
互換性のある修正版を作れないため PR を作成できない。advisory 参照を持つ ExpectedUpdate にのみ意味を持つ。

**merged_not_effective**:
PR は merge 済みだが、現在の default branch の再評価では更新が有効になっていない (revert、lockfile 再解決など)。

**effective**:
現在の default branch 上で更新が有効と確認された終端状態。

**superseded**:
依存自体の削除や、より新しい ExpectedUpdate への置き換えにより追跡が無意味になった終端状態。

### Finding 種別

**coverage_gap** (subject: manifest):
manifest に対する bot 設定または security feature が存在しない。

**policy_drift** (subject: bot 設定):
schedule、group、target branch などが組織 policy と異なる。

**paused_or_stalled** (subject: bot 設定 / run):
bot が paused、または期待した run が観測できない。

**exception_active** (subject: 例外レコード):
owner、理由、期限を持つ承認済み例外。エスカレーションを抑止する注記として働く。

### 導出 Finding (保存されない)

**vulnerable_unpatched**:
advisory 参照付き ExpectedUpdate が未解決 (effective でない) であることから導出される。

**sla_breached**:
vulnerable_unpatched の条件に加え、policy の対応期限を超過していることから導出される。
