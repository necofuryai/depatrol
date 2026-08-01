# AGENTS.md

This file is the shared source of truth for repository instructions used by coding agents. Claude Code loads these instructions through [CLAUDE.md](CLAUDE.md); keep Claude Code-specific instructions in that file and do not duplicate shared guidance.

## Project context

depatrol is an open-source, read-only control plane for dependency-update health across repositories. The project is pre-alpha. The M0 CLI is released as v0.1.0 through GitHub Releases, `go install`, and npm. The current implementation supports Dependabot on GitHub; Renovate support is planned for M1.

- Treat [README.md](README.md) as the source of truth for public product scope, status, installation, and contribution entry points.
- Treat [CONTEXT.md](CONTEXT.md) as the source of truth for domain terminology. Findings are non-exclusive observations; do not describe the published rollup vocabulary as an internal state machine.
- Use [docs/research/2026-08-01-market-research.md](docs/research/2026-08-01-market-research.md) for the founding market research, competitive analysis, MVP boundaries, and no-go criteria.
- Record architectural decisions in [docs/decisions/](docs/decisions/). The project uses Apache-2.0 with DCO sign-off (ADR 0001) and Go (ADR 0002, with a reconsideration gate before M1). Distribution is defined by ADR 0006, and release operations live in [docs/runbooks/release.md](docs/runbooks/release.md). A tag push is the only release trigger.
- Use [ROADMAP.md](ROADMAP.md) for milestone scope and validation policy. The current validation track is "minimum public release, then observe signals."

## Development workflow

- [CONTRIBUTING.md](CONTRIBUTING.md) is the source of truth for issues, pull requests, commit format, DCO sign-off, and local validation.
- Use trunk-based development. `main` is the only long-lived branch, and every change must go through a pull request from a short-lived `<type>/<topic>` branch. The protected `main` branch requires the `test` check and applies enforcement to administrators.
- Write commit subjects and pull request titles in English using `<type>: <description>`.
- Keep each pull request focused on one concern. Changes to a product boundary or architectural decision require an ADR in the same pull request or a preceding one.
- Before pushing, run `go build ./...`, `go vet ./...`, verify that `gofmt -l .` prints nothing, and run `go test ./...`.
