# 0003. version 解決を自前で行わず、ExpectedUpdate の実体化を外部観測に限定する

- ステータス: 採択
- 日付: 2026-08-01

## 背景

domain model の grilling (2026-08-01) で、ライフサイクル追跡の entity を ExpectedUpdate (同一性: repository × manifest × dependency) と定めた。次の問いは「depatrol は『更新が利用可能である』という事実をどう知るか」だった。

registry を自前で照会して version 解決を行えば「bot が見落とした更新」も検出できるが、それは ecosystem ごとの解決実装 (npm、pip、cargo、Maven...) を意味し、Renovate のコア機能の再実装になる。設立調査 (docs/research/2026-08-01-market-research.md) は「新しい更新 bot」を作る方向を明確に退けている。

## 決定

depatrol は version 解決を一切自前で行わない。

ExpectedUpdate の実体化 (materialization) の情報源を次の三系統に限定する。

1. **security alert** — Dependabot alerts API。将来は OSV-Scanner / dependency-management-data の adapter。advisory 参照付き ExpectedUpdate を実体化する。
2. **bot 自身の出力** — 更新 PR (Dependabot / Renovate)、Renovate の Dependency Dashboard issue。version update の ExpectedUpdate を実体化する。
3. **scanner adapter** (M2 以降) — default branch 再評価と同じ機構による advisory 参照付きの補完。

## 理由

1. 「version 解決」は更新 bot の bounded context に属する知識であり、depatrol はその出力を証跡として消費する下流に位置する。境界を越えると製品の比較軸が「監視ツール vs 更新 bot」から「更新 bot vs 更新 bot」に変わり、差別化が崩壊する。
2. read-only control plane、「既存 bot の実行信頼性と修正到達を検証する」という設立調査の製品定義と正確に一致する。
3. ecosystem ごとの解決実装は保守コストが恒久的に発生し、feasibility spike の検証対象 (run evidence の取得精度) から資源を奪う。

## 帰結

- **depatrol は「bot が見落とした version update」を検出できない。** 検証するのは bot の網羅性ではなく実行信頼性である。この制限は受け入れる。security については alert という独立情報源があるため、この制限は security 側には及ばない。
- `pending` 状態の可観測性が情報源によって非対称になる: Renovate は Dependency Dashboard issue で観測可能、security は alert で観測可能、**Dependabot の version update は PR が現れて初めて実体化** (`update_open` から開始)。この非対称は世界の側の構造であり、モデルに正直に写す。
- 将来この決定を覆す場合 (registry 照会の導入) は、本 ADR を更新し、製品ポジショニングの再定義とセットで行うこと。
