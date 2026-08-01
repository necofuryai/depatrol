# 0001. ライセンスは Apache-2.0、コントリビューションは DCO

- ステータス: 採択
- 日付: 2026-08-01

## 背景

個人発の OSS として公開し、企業の Platform Engineering / AppSec チームに採用してもらうことを狙う。

隣接 OSS のライセンス実勢 (2026-08-01 に GitHub API で検証):

- Apache-2.0: dependency-management-data、Dependency-Track、OSV-Scanner、GUAC、Allstar、Watchtower、repo-guardian、updatecli、Frogbot
- MIT: Evergreen、gh-dep、DashGit、Renovate Operator、lazyreno
- AGPL-3.0: Renovate 本体、Kodiak
- BSD-3-Clause: DefectDojo

作者の優先順位は、採用の広がりを最大化しつつ、将来の商用化 (デュアルライセンス等) の選択肢を残すこと。

## 決定

Apache-2.0 を採用する。

コントリビューションには DCO (Developer Certificate of Origin、`Signed-off-by`) を必須にする。

## 理由

1. 供給網セキュリティ分野の中核 OSS (DMD、Dependency-Track、OSV-Scanner、GUAC) は Apache-2.0 が主流で、企業のライセンス審査を通しやすい。
2. 明示的な特許ライセンス (§3) と特許報復条項が、MIT にはない保護を利用者と作者の双方に与える。
3. §5 (inbound=outbound) により、外部コントリビューションが自動的に同条件で受領され、追加の合意なしに由来が揃う。
4. 単独著作権者である間は、将来のデュアルライセンスや商用版の選択肢が残る。DCO は CLA より軽く、この選択肢を保つための由来記録として十分。
5. AGPL は退けた。対象ユーザー層に AGPL 禁止ポリシーの企業が多く、read-only の監視ツールは SaaS として収奪されるリスクが相対的に小さいため、採用の阻害が保護の利益を上回る。
6. MIT は退けた。このニッチでは Apache-2.0 に対する採用上の優位がなく、特許条項を失うだけになる。

## 帰結

- LICENSE に Apache-2.0 全文を置く。
- README とコントリビューションガイドに DCO 必須 (`git commit -s`) を明記する。
- 外部コントリビューションが増える前にライセンス方針を変える場合は、この ADR を更新して判断の跡を残す。
