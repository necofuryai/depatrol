# Contributing to depatrol

Thanks for your interest in depatrol. This document is the single source of truth for how issues are filed, how changes are proposed, and what a pull request needs before it can merge.

depatrol is **pre-alpha**. The domain model is settled ([CONTEXT.md](CONTEXT.md), [docs/decisions/](docs/decisions/)), but interfaces and internals change quickly. Opening an issue to discuss a change before writing code is the cheapest way to avoid wasted work.

## Filing issues

- Search existing issues first, including closed ones.
- **Bug reports** and **feature requests** have issue forms — please use them. Free-form issues are fine for questions and discussions that fit neither form.
- **Security vulnerabilities must not be filed as public issues.** Use GitHub's private vulnerability reporting (repository **Security** tab → *Report a vulnerability*).
- Before requesting a feature, check the two product boundaries. Requests that cross them will be declined with a pointer to the ADR:
  - depatrol never resolves versions itself — it verifies what your bots promised, not what was possible ([ADR 0003](docs/decisions/0003-no-version-resolution.md)).
  - depatrol never writes anywhere — read-only credentials, governance as declarative YAML in your own repository ([ADR 0004](docs/decisions/0004-governance-as-code.md)).
- [ROADMAP.md](ROADMAP.md) lists what each milestone adds; a request may already be planned.

### Labels

Maintainers triage every issue. Most labels are GitHub defaults; one is project-specific:

- `ready-for-agent` — the issue carries a complete spec (acceptance criteria and blocking edges) and can be picked up for implementation without further discussion. Maintainers apply it; contributors don't need to.

## Proposing changes

### Branch and PR workflow

The repository is trunk-based: `main` is the only long-lived branch, and it is protected (required CI check `test`, enforced for admins too), so every change lands through a pull request — maintainers included.

1. Fork (or branch, for maintainers) from `main` using a short-lived branch named `<type>/<topic>`, e.g. `fix/pause-detection`, `docs/renovate-notes`.
2. Keep the PR small and focused — one concern per PR.
3. Reference the issue it addresses (`Closes #123`) when one exists. For non-trivial changes, an issue first is strongly preferred.
4. Changes that move a product boundary or an architectural decision need an ADR in [docs/decisions/](docs/decisions/) — in the same PR or a preceding one.

### Commit messages

```
<type>: <description>
```

- Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`.
- Written in English, imperative mood, no trailing period on the subject line.
- PR titles follow the same format — a squash-merged PR title becomes a commit subject.

### DCO sign-off

Every commit must carry a `Signed-off-by` line certifying the [Developer Certificate of Origin](https://developercertificate.org/) ([ADR 0001](docs/decisions/0001-license.md)):

```console
git commit -s
```

The sign-off asserts you have the right to submit the change under the project license. There is no CLA.

### Before you push

CI runs exactly these; run them locally first (Go version comes from `go.mod`):

```console
go build ./...
go vet ./...
gofmt -l .
go test ./...
```

`gofmt -l .` must print nothing. Behaviour changes need tests — HTTP interactions are tested with recorded cassettes (`go-vcr`), so no live GitHub token is required to run the suite.

## License

Apache-2.0. Per its §5, any contribution intentionally submitted for inclusion is accepted under the same terms (inbound = outbound) — the DCO sign-off records that provenance.
