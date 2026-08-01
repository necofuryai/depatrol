# depatrol

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

Pre-alpha, design phase. The implementation language is intentionally undecided (see [docs/decisions/](docs/decisions/)).

First milestone: a feasibility-spike CLI that scans a set of repositories with read-only GitHub credentials and classifies each into the state model below, distinguishing `confirmed` evidence from `inferred`.

## State model (draft)

| State | Meaning |
|---|---|
| `healthy` | Matches policy, no outstanding anomalies |
| `coverage_gap` | Manifest without bot config or security feature |
| `policy_drift` | Schedule, groups, or target branch deviate from org policy |
| `paused_or_stalled` | Bot paused, or expected runs not observed |
| `update_open` | Update PR awaiting processing |
| `blocked` | Stopped for an explainable reason (CI, conflict, review, constraint) |
| `fix_unavailable` | Alert exists but no compatible fixed version can be built |
| `merged_not_effective` | Merged, but re-evaluation of the current default branch shows the fix is not effective |
| `vulnerable_unpatched` | Unfixed vulnerability remains on the current default branch |
| `exception_active` | Approved exception with owner, reason, and expiry |
| `sla_breached` | Past the response deadline defined by policy |

## Background

Founded on a market and competitive study (2026-08): [docs/research/2026-08-01-market-research.md](docs/research/2026-08-01-market-research.md) (Japanese).

## License

Apache-2.0. Contributions require a DCO sign-off (`git commit -s`).
