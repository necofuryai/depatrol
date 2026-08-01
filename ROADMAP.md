# ロードマップ (ドラフト)

このロードマップは設立調査 (docs/research/) から導いた草案であり、grilling と spec 化の過程で書き直す前提である。

## M0: feasibility spike CLI

- read-only 資格情報 (PAT) で複数リポジトリを走査し、11 状態モデルに分類して表 / JSON で出力する。
- 調査の No-go 条件「Dependabot の run evidence を十分な精度で取得できない」をここで実証または棄却する。
- run evidence が API で取れない場合は、config schedule、cooldown、paused state、Pull Request activity からの推定にフォールバックし、出力で `confirmed` と `inferred` を区別する。
- 停滞判定は schedule の額面ではなく cooldown とグループ設定を解釈する (額面だけで判定すると正常なリポジトリを停滞と誤判定する)。

## M1: bot 中立の状態モデル v1

- Renovate adapter を追加する。bot の識別は GitHub App ID、login、label、branch prefix を設定可能にする (self-hosted Renovate は login を変えられるため)。
- Dependabot adapter と統一した状態モデルで出力する。

## M2: default branch 到達検証

- merge commit の祖先判定と、現 default branch の manifest / lockfile 再走査 (OSV-Scanner または dependency-management-data との連携) を照合する。
- `merged_not_effective` (merge 済みだが現 default branch では修正が有効でない) を検出する。

## M3: SLA / policy エンジン

- severity、EPSS、patch availability、dependency scope、repository criticality による SLA 判定。
- owner と例外 (期限付き) のモデル。JSON と Prometheus metrics の出力。

## M4: パッケージング

- read-only GitHub App 化と最小 Web UI。

## 並走: 需要検証

- Platform Engineering、AppSec、OSPO への 10 から 15 人のインタビュー (質問リストは設立調査を参照)。
- 3 組織以上が集まれば 4 週間の read-only pilot を行い、Go / Pivot / No-go を判定する。
