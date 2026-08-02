# 0002. 実装言語は Go

- ステータス: 採択
- 日付: 2026-08-01 (設計レビューを経て同日採択)

## 背景

feasibility spike CLI から始め、将来は read-only GitHub App と最小 Web UI まで育てる。候補は TypeScript (Node 22)、Go、Rust。

当初の決定プロセスは「1. 設計レビューで要件と制約を整理する → 2. 必要なら三候補で最小実装比較 → 3. 採択」だった。2026-08-01 の設計レビュー (ステップ 1) で要件が確定し、その過程の二つの決定が選定の力学を変えた。

1. **ADR 0003 (version 解決を自前で行わない)** により、Renovate (TS 製) のエコシステム実装を再利用するという TS の最大の誘因が消滅した。
2. **ADR 0004 (governance-as-code)** により M4 の Web UI は閲覧専用となり、「フルスタック TS で管理画面まで」という第二の誘因も弱まった。

## 決定

Go を採択する。

ステップ 2 (三言語での最小実装比較) は省略する。代わりに M0 自体を実地検証とし、M0 完了時に「Go で苦痛だった点」を本 ADR に追記して、M1 着手前を再考ゲートとする。

## 理由

1. 単一バイナリ配布が M0 CLI の「試しやすさ」に直結する。dogfooding と公開シグナル観測を検証の中心に据えた (ROADMAP 並走レーン) 以上、配布の軽さは検証計画の一部である。
2. M2 で連携する dependency-management-data と OSV-Scanner はともに Go 製で、ライブラリレベルの連携が開ける。
3. go-github + githubv4 で REST と GraphQL の両対応が成熟している。organization 横断走査の並行処理と rate limit 制御も goroutine + 既存 rate limiter で書きやすい。
4. この分野の隣接 OSS は Go が実勢であり、コントリビューター獲得に有利。
5. 比較実装は三通りの GitHub API クライアント習作に個人開発の最稀少資源 (時間) を払う行為で、要件確定後の期待情報価値に見合わない。TS の固有利点は上記のとおり消滅し、Rust には学習コストに見合う固有利点がない。

## 帰結

- 作者の開発速度は TS が最速だったため、その優位は失う。受け入れる。
- M0 完了時に実装上の苦痛点を本 ADR に追記し、M1 着手前に一度だけ再考する。覆すコストが最小のうちに見直すためのゲートであり、以降は再考しない。

## M0 実装後の記録 (2026-08-01)

- 苦痛点は実質なし。go-github v89 はコンストラクタが `NewClient(opts...)` に破壊的変更されていたが、`go doc` で即座に吸収できた。alert / PR / checks / commits の型は成熟しており、手書きの型定義はゼロで済んだ。
- 本 ADR の評価基準にあった「PR timeline の一括取得は GraphQL が効率的」は、M0 の規模 (リポジトリ逐次走査 + open PR ごとに 3 呼び出し) では REST のみで足りた。organization 規模が大きくなる M1 以降で再評価する。
- 単一バイナリ配布と goroutine 並行走査は M0 では未活用 (逐次 + rate 制限で十分)。配布の軽さは dogfooding 開始時に効く見込み。
- 再考ゲート (M1 着手前) の判断材料として: Go を覆す理由は現時点で観測されていない。

## M0 技術関門の判定 (2026-08-02)

M0 の技術的 No-go 条件は発火せず、M1 へ継続可能と判定した。
実装言語は M1 でも Go を継続する。

作者の公開リポジトリ4件に対する dogfooding は scan error 0件で完了した。
schedule を持つ実リポジトリ1件で stalled の誤検出はなく、病理系と cooldown 境界は合成 cassette で再現できた。
詳細は [M0 dogfooding 結果](../validation/2026-08-02-m0-dogfooding.md) に記録した。

この判定は「Dependabot の run 成功を直接観測できる」ことを意味しない。
GitHub API は最終成功 run を直接返さないため、stalled は schedule、cooldown、bot activity から導く `inferred` の判定として維持する。
この Evidence 連鎖を人間が監査できる範囲では技術的 No-go 条件に該当しないが、policy gate や自動修正の確定根拠には使わない。
