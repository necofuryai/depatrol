# depatrol

**English** | [日本語](README.ja.md)

Read-only control plane for dependency update bots.

depatrol watches Dependabot and Renovate across all your repositories and answers one question with evidence: **is every repository actually receiving and absorbing dependency updates?**

Existing tools tell you a bot is *configured* (OpenSSF Scorecard, Evergreen) or aggregate open alerts (GitHub Security Overview, Dependency-Track). None of them verify, bot-neutrally and continuously, that:

1. every repository and manifest is covered by an update bot,
2. the bot is configured according to organization policy,
3. scheduled runs actually happen — Dependabot silently pauses after 90 days of untouched PRs, or after 15 failed runs,
4. an update PR exists for every available fix, or the reason it cannot be created is known,
5. stalled PRs are explained (CI, merge conflicts, review, rate limits, version constraints),
6. merged fixes are *effective on the current default branch* — not reverted, not re-resolved back to a vulnerable version,
7. unpatched vulnerabilities that breach a policy SLA are escalated to a known owner.

"A config file exists" and "the update machinery is healthy" are not the same thing. depatrol treats the gap between them as its product.

## Status

Pre-alpha. The first milestone — a feasibility-spike CLI that scans repositories with read-only GitHub credentials and reports the conditions below, every judgment carrying its evidence chain marked `confirmed` or `inferred` — is released as **v0.1.0**; see [Installation](#installation).

Scope today is Dependabot on GitHub. Renovate (M1), default-branch re-verification of version updates (M2), and the governance engine — policy, owners, exceptions, SLA (M3) — are not implemented yet; [ROADMAP.md](ROADMAP.md) says what each milestone adds. The domain model is settled (see [CONTEXT.md](CONTEXT.md) and [docs/decisions/](docs/decisions/)); the implementation language is Go (ADR 0002).

## Installation

Every distribution channel ships from the same git tag (ADR 0006). At run time the CLI needs a read-only GitHub token in `GITHUB_TOKEN` (or `GH_TOKEN`).

### npm — no toolchain required

```console
npx depatrol scan --org your-org
```

`bunx depatrol` and `pnpm dlx depatrol` work the same way. The package resolves a platform-specific binary through `optionalDependencies` and has no install scripts, so `npm install --ignore-scripts` also works.

If `npm ci` fails with `Cannot find module @depatrol/cli-...`, the lockfile was written by an older npm that dropped other platforms' optional dependencies ([npm/cli#4828](https://github.com/npm/cli/issues/4828)). Delete `package-lock.json` and `node_modules`, then run `npm install` again.

### go install

```console
go install github.com/necofuryai/depatrol@latest
```

### Binary archives

[GitHub Releases](https://github.com/necofuryai/depatrol/releases) carries archives for darwin (arm64 / amd64), linux (amd64 / arm64), and windows (amd64), each release with sha256 checksums.

## Domain model

depatrol uses a two-layer model:

- **Findings** — verified observations attached to a subject (a manifest, a bot config, an exception record). Multiple findings coexist per repository; they are not exclusive states.
- **ExpectedUpdate lifecycle** — every update that should happen is tracked as an *ExpectedUpdate* (identity: repository × manifest × dependency) moving through `pending → update_open → blocked ⇄ …` until it is confirmed `effective` on the current default branch or retired as `superseded`, regardless of whether a PR exists yet; a merged-but-ineffective fix stays tracked as `merged_not_effective`. PRs and alerts are evidence linked to the entity, not the entity itself, so tracking survives PR recreation and grouped PRs.
- **Evidence** — every judgment cites the observations behind it. Each observation is `confirmed` (directly observed) or `inferred` (estimated); a judgment is only `confirmed` if every load-bearing observation is (weakest-link rule).

Two boundary decisions define the product:

- **depatrol never resolves versions itself** (ADR 0003). It verifies that your bots do what they promise — not that they promised everything possible.
- **depatrol never writes anywhere** (ADR 0004). Policy, owner mapping, and exceptions are declarative YAML in your own governance repository; approving an exception is a pull request merge, and the audit trail is git history.

## Repository rollup vocabulary

In cross-repository views, each repository is labeled with the most severe condition present (with per-condition counts alongside). From most to least severe:

| Label | Meaning |
|---|---|
| `sla_breached` | Past the response deadline defined by policy (derived) |
| `vulnerable_unpatched` | Unfixed vulnerability remains on the current default branch (derived) |
| `merged_not_effective` | Merged, but re-evaluation of the current default branch shows the fix is not effective |
| `fix_unavailable` | Alert exists but no compatible fixed version can be built |
| `blocked` | Update PR stopped for an explainable reason (CI, conflict, review, constraint) |
| `paused_or_stalled` | Bot paused, or expected runs not observed |
| `coverage_gap` | Manifest without bot config or security feature |
| `policy_drift` | Schedule, groups, or target branch deviate from org policy |
| `update_open` | Update PR awaiting processing |
| `pending` | Update known to be available but not yet effective on the default branch — before the bot creates a PR, or in the post-merge grace period until re-evaluation confirms the fix (normal within schedule/cooldown) |
| `healthy` | No findings, no unresolved ExpectedUpdates (derived) |

A condition covered by an approved exception is suppressed from the rollup (but stays recorded); a repository whose every condition is suppressed shows `exception_active`.

This table is the full vocabulary, not the current output: `policy_drift`, `sla_breached`, and `exception_active` depend on the governance engine (M3) and are not emitted by v0.1.0.

## Background

Founded on a market and competitive study (2026-08): [docs/research/2026-08-01-market-research.md](docs/research/2026-08-01-market-research.md) (Japanese).

## Contributing

Issue forms, the pull request checklist, and the full workflow — trunk-based branches, commit format, DCO — are in [CONTRIBUTING.md](CONTRIBUTING.md). Report security vulnerabilities privately via the repository Security tab, never as public issues.

## License

Apache-2.0. Contributions require a DCO sign-off (`git commit -s`).
