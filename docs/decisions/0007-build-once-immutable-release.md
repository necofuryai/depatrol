# 0007. Release は一度だけ build し、検証済みの同一成果物を配布する

- ステータス: 採択
- 日付: 2026-08-10
- 置換対象: ADR 0006 の決定 1〜3

## 背景

ADR 0006 は git tag を release ID とし、GitHub Releases の成果物を npm が再梱包する方式を採択した。
同 ADR は、公開に失敗した場合に同じ tag から GoReleaser を再実行し、既存 asset を置換して修復することも認めていた。

この方式では、再実行した build が最初の build と同一 byte であることを配布前に証明できない。
さらに、GitHub Release を immutable にすると、公開済み asset の置換は修復手段として使えない。
依存更新 bot が release workflow と build tool も更新するため、merge 時の検証だけでなく、tag から公開までの trust boundary を明示する必要がある。

## 決定

1. Release の起点は、`vMAJOR.MINOR.PATCH` と完全一致する stable SemVer の signed annotated tag に限定する。
   署名はリポジトリに登録した公開鍵で検証する。
   Tag の commit は release hardening marker を導入した commit 以後で、`main` の祖先でなければならない。
   `main` は workflow 実行中にも進み得るため、tag commit と最新の `main` tip の一致までは要求しない。
   ただし、operator は原則として最新の green な `origin/main` に tag を作成する。
2. GoReleaser は publish 機能を無効化し、`release-build` job で一度だけ archive、checksum、release notes、manifest を生成する。
   Build metadata の日付には実行時刻ではなく commit date を使う。
3. `release-build` は bundle 内の各 file に GitHub artifact attestation を付与し、tag と commit を含む固定名の Actions artifact として保存する。
   GitHub Release と npm は、その artifact を download して manifest、digest、attestation を検証した後に配布する。
4. GitHub Release は draft を作成し、全 asset の一致を確認してから publish する。
   新しい release には repository-level immutable releases を適用し、公開後の asset 追加、削除、置換を認めない。
5. npm は 6 package の tarball を先に固定し、platform package を先、main package を最後に publish する。
   同じ version が npm registry に存在する場合は、registry の SRI と今回の tarball が完全一致するときだけ成功済みとして扱う。
   SRI が異なる場合は処理を停止し、新しい patch release を要求する。
6. 部分失敗は、元の Actions artifact が残っている 30 日以内に `Re-run failed jobs` で修復する。
   `Re-run all jobs` は同名 artifact の再 upload を `overwrite: false` で拒否し、再 build を publish path に混入させない。
   Artifact が失われた場合、公開済み成果物と不一致がある場合、または 30 日を超えた場合は、新しい patch release を作成する。
7. Immutable releases を遡及適用できない既存 release は、tag commit と asset digest を baseline として記録し、定期 workflow で drift を検出する。

## 理由

Build と publish を分離し、配布先が同じ attested artifact を読む構造にすると、GitHub Release と npm の入力を一つに固定できる。
公開済み version の衝突時に byte 同一性を検証すれば、「version が存在する」という弱い判定で異なる成果物を成功扱いすることもない。
Immutable release を前提に retry 境界を定めることで、障害復旧のために supply-chain invariant を緩めずに済む。

## 帰結

- ADR 0006 の「GitHub Release asset を npm job が取得してから再 packaging する」という実装は、Actions artifact を共通入力とする方式へ置き換わる。
- ADR 0006 の `replace_existing_artifacts` による修復は廃止する。
- 同じ tag で許可するのは、元の Actions artifact を再利用する未完了 channel の retry だけである。
- Release workflow、GoReleaser 設定、npm packaging、署名鍵、hardening marker は保護対象とし、通常の Pull Request review を必須にする。
- 個人リポジトリで maintainer 自身が作成した Pull Request は自己承認できないため、admin の PR-only bypass を意図的な例外として残す。
  Renovate が作成した Pull Request は maintainer が承認できる。
