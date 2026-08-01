# M0 dogfooding 結果

- 実施日：2026-08-02
- 実行 commit：`04070c65e2ab158ee1439e1f17d717f22d10fbaa`
- 対象：作者が所有する公開リポジトリ4件
- 実行方法：read-only の GitHub token を環境変数で渡し、`depatrol scan --repo ... --output json` を実行
- 対象リポジトリ：`necofuryai/depatrol`、`necofuryai/necofuryai.dev`、`necofuryai/dotfiles`、`necofuryai/genko-zed`

## 観測結果

4件すべての走査が完了し、`scan_errors` は0件だった。

| リポジトリ | rollup | 主な観測 |
|---|---|---|
| `necofuryai/depatrol` | `coverage_gap` | 5件 |
| `necofuryai/necofuryai.dev` | `healthy` | `effective` 1件 |
| `necofuryai/dotfiles` | `coverage_gap` | 2件 |
| `necofuryai/genko-zed` | `coverage_gap` | 1件 |

既存のリポジトリ別画面では横断集計していなかった `coverage_gap` を8件検出した。

| pilot 測定項目 | 検出数 | 修正数 |
|---|---:|---:|
| `coverage_gap` | 8 | 0 |
| `paused_or_stalled` | 0 | 0 |
| `blocked` | 0 | 0 |
| `merged_not_effective` | 0 | 0 |

この実行に伴う修正は合計0件だった。
この値は検出能力と修正効果を混同しないための初回基準値であり、設定変更は別の運用判断として扱う。

`paused_or_stalled`、`blocked`、`merged_not_effective` はいずれも0件だった。
Dependabot の schedule を持つ実リポジトリは `necofuryai/necofuryai.dev` の1件であり、この対象では stalled の誤検出はなかった。
残る3件では schedule が存在しないため、depatrol は停止を推定せず `coverage_gap` と判定した。

## 健全系の回帰対象

既知の健全系は、実 API から記録した `necofuryai/necofuryai.dev` と、schedule および cooldown の境界を固定した合成 cassette 群で構成する。
すべての対象で `paused_or_stalled` の誤検出が0件であることを同じ CLI seam から検証する。

作者の private リポジトリ11件も候補として確認したが、M0 が読む `.github/dependabot.yml` を持つ対象は0件だった。
第三者が所有する公開リポジトリでは、token に Dependabot alerts の閲覧権限がなく `alerts_open` の走査エラーになることを確認した。
したがって、設定ありの実リポジトリを複数件とする条件は今回の n=1 環境では満たせない。
この制約を合成 cassette で隠さず、M1 以降の dogfooding で実対象を追加する。

## 技術的 Go / No-go 判定

M0 の技術的 No-go 条件は発火せず、**M1 へ継続可能**と判定する。

実 API 由来の応答を使う走査が完了し、schedule、cooldown、bot activity を根拠とする Evidence 連鎖を JSON で監査できた。
合成 cassette では paused、stalled、cooldown 境界、`merged_not_effective` などの病理系を再現し、実 API 由来の cassette と合わせた回帰テストが成功している。

ただし、GitHub API は Dependabot の最終成功 run を直接返さない。
そのため `paused_or_stalled` の stalled 側は今後も `inferred` として扱い、単独で自動修正や policy gate の根拠にはしない。
今回の実リポジトリ検証は schedule あり1件を含む n=1 の初期検証であり、M1 以降も対象を増やして誤検出を観測する。

第三者リポジトリの走査エラーは run evidence の誤判定ではなく、GitHub の認可境界である。
