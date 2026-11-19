import {
  Confidence,
  EvidenceMethod,
  FindingType,
  LifecycleState,
  SubjectKind,
  formatRFC3339,
  weakestLink,
  type Evidence,
  type ExpectedUpdate,
  type Finding,
} from "../domain/domain.ts";
import type { BotConfig } from "./botconfig.ts";
import type {
  GitHubAutomatedSecurityFixes,
  GitHubCheckRun,
  GitHubDependabotAlert,
  GitHubPullRequest,
  GitHubPullRequestReview,
} from "./github.ts";
import { detectManifests, directoryOf, manifestDirectory } from "./manifests.ts";

/**
 * dependabotLogin is fixed in M0. Configurable bot identity (self-hosted
 * Renovate can change its login) is M1's adapter work.
 */
export const DEPENDABOT_LOGIN = "dependabot[bot]";

export const MS_PER_HOUR = 3_600_000;
export const MS_PER_DAY = 86_400_000;

/**
 * How long after a merge GitHub's own re-evaluation of the default branch is
 * given to resolve the alert before an unresolved alert counts as
 * merged_not_effective.
 */
const MERGE_REEVALUATION_GRACE_MS = 24 * MS_PER_HOUR;

/**
 * How long requested reviewers may sit silent before that silence counts as a
 * review-wait blocked reason.
 */
const REVIEW_WAIT_GRACE_DAYS = 7;

const ZERO_TIME_MS = Date.parse("0001-01-01T00:00:00Z");

/**
 * Per-PR observation set needed to explain why an open update PR is stopped.
 */
export interface PRDetail {
  full: GitHubPullRequest | null;
  reviews: GitHubPullRequestReview[];
  checks: GitHubCheckRun[];
}

/**
 * Everything M0 reads about one repository before judging.
 */
export interface Observation {
  owner: string;
  name: string;
  defaultBranch: string;
  treePaths: string[];
  /** null when no dependabot.yml exists */
  config: BotConfig | null;
  securityFixes: GitHubAutomatedSecurityFixes | null;
  openAlerts: GitHubDependabotAlert[];
  fixedAlerts: GitHubDependabotAlert[];
  /** Dependabot-authored only */
  openPRs: GitHubPullRequest[];
  /** Dependabot-authored only */
  closedPRs: GitHubPullRequest[];
  /** Keyed by open PR number */
  prDetails: Map<number, PRDetail>;
  /** Newest default-branch commit authored by the bot */
  lastBotCommit: Date | null;
  /** Dependabot alerts are disabled for the repository */
  alertsDisabled: boolean;
}

export function parseTimestampOrZero(iso: string | null | undefined): Date {
  if (!iso) {
    return new Date(ZERO_TIME_MS);
  }
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    return new Date(ZERO_TIME_MS);
  }
  return new Date(ms);
}

/**
 * Formats a Date as UTC RFC3339 with seconds precision (matching Go's
 * `time.Time.Format(time.RFC3339)`).
 */
export function formatRFC3339Seconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function makeEvidence(
  now: Date,
  source: string,
  method: EvidenceMethod,
  description: string,
  confidence: Confidence,
): Evidence {
  return {
    source,
    method,
    description,
    confidence,
    observed_at: formatRFC3339(now),
  };
}

/**
 * Parses Dependabot's single-dependency PR titles, e.g.
 * "Bump lodash from 4.17.20 to 4.17.21 in /app", optionally prefixed by a
 * configured conventional-commit prefix.
 */
const BUMP_TITLE_RE =
  /^(?:\w+(?:\([^)]*\))?:\s*)?[Bb]ump (\S+) from (\S+) to (\S+?)(?: in (\S+))?$/;

export interface ParsedPR {
  pr: GitHubPullRequest;
  dependency: string;
  fromVersion: string;
  toVersion: string;
  /** "/" when the title names no directory */
  directory: string;
}

export function prAgeDays(now: Date, pr: GitHubPullRequest): number {
  const created = parseTimestampOrZero(pr.created_at);
  const age = Math.trunc((now.getTime() - created.getTime()) / MS_PER_DAY);
  return age <= 0 ? 0 : age;
}

export function parseBumpTitle(pr: GitHubPullRequest): ParsedPR | null {
  const title = pr.title ?? "";
  const m = BUMP_TITLE_RE.exec(title);
  if (m === null) {
    return null;
  }
  const dependency = m[1];
  const fromVersion = m[2];
  const toVersion = m[3];
  if (dependency === undefined || fromVersion === undefined || toVersion === undefined) {
    return null;
  }
  const dir = m[4] && m[4] !== "" ? m[4] : "/";
  return { pr, dependency, fromVersion, toVersion, directory: dir };
}

interface UpdateIdentity {
  manifest: string;
  dependency: string;
}

function identityKey(id: UpdateIdentity): string {
  return JSON.stringify([id.manifest, id.dependency]);
}

function alertIdentity(a: GitHubDependabotAlert): UpdateIdentity {
  return {
    manifest: a.dependency?.manifest_path ?? "",
    dependency: a.dependency?.package?.name ?? "",
  };
}

function findOpenBotPR(
  open: readonly GitHubPullRequest[],
  dependency: string,
  directory: string,
): ParsedPR | null {
  for (const pr of open) {
    const p = parseBumpTitle(pr);
    if (p === null) {
      continue;
    }
    if (p.dependency === dependency && p.directory === directory) {
      return p;
    }
  }
  return null;
}

function findMergedBotPR(
  closed: readonly GitHubPullRequest[],
  dependency: string,
  directory: string,
): ParsedPR | null {
  for (const pr of closed) {
    if (!pr.merged_at) {
      continue;
    }
    const p = parseBumpTitle(pr);
    if (p === null) {
      continue;
    }
    if (p.dependency === dependency && p.directory === directory) {
      return p;
    }
  }
  return null;
}

function mergedPREvidence(
  now: Date,
  obs: Observation,
  merged: ParsedPR,
  dependency: string,
): Evidence {
  return makeEvidence(
    now,
    `GET /repos/${obs.owner}/${obs.name}/pulls?state=closed`,
    EvidenceMethod.Parse,
    `Dependabot pull request #${merged.pr.number ?? 0} bumping ${dependency} to ${merged.toVersion} was merged at ${formatRFC3339Seconds(parseTimestampOrZero(merged.pr.merged_at))}`,
    Confidence.Confirmed,
  );
}

/**
 * Inspects one open PR's detail observations for the blocked reasons M0 can
 * observe directly (failing checks, merge conflict, changes requested) plus
 * inferred prolonged review-wait.
 *
 * Intentional determinism fix over Go internal/scan/updates.go:146:
 * reviewer logins are sorted in ascending UTF-16/codepoint order before
 * selecting the first CHANGES_REQUESTED review.
 */
function blockedReasons(
  now: Date,
  obs: Observation,
  pr: GitHubPullRequest,
): { reasons: string[]; evidence: Evidence[] } {
  const prNumber = pr.number ?? 0;
  const d = obs.prDetails.get(prNumber);
  if (d === undefined) {
    return { reasons: [], evidence: [] };
  }

  const reasons: string[] = [];
  const evidence: Evidence[] = [];

  for (const c of d.checks) {
    if (c.status === "completed" && (c.conclusion === "failure" || c.conclusion === "timed_out")) {
      reasons.push("ci_failing");
      evidence.push(
        makeEvidence(
          now,
          `GET /repos/${obs.owner}/${obs.name}/commits/${pr.head?.sha ?? ""}/check-runs`,
          EvidenceMethod.APIRead,
          `check run ${JSON.stringify(c.name ?? "")} concluded ${c.conclusion} on the head commit of PR #${prNumber}`,
          Confidence.Confirmed,
        ),
      );
      break;
    }
  }

  if (d.full !== null && d.full.mergeable === false) {
    reasons.push("merge_conflict");
    evidence.push(
      makeEvidence(
        now,
        `GET /repos/${obs.owner}/${obs.name}/pulls/${prNumber}`,
        EvidenceMethod.APIRead,
        `GitHub reports PR #${prNumber} as not mergeable (state ${JSON.stringify(d.full.mergeable_state ?? "")})`,
        Confidence.Confirmed,
      ),
    );
  }

  const latest = new Map<string, GitHubPullRequestReview>();
  for (const r of d.reviews) {
    const u = r.user?.login ?? "";
    const prev = latest.get(u);
    if (
      prev === undefined ||
      parseTimestampOrZero(r.submitted_at).getTime() >
        parseTimestampOrZero(prev.submitted_at).getTime()
    ) {
      latest.set(u, r);
    }
  }
  const sortedReviewers = [...latest.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const user of sortedReviewers) {
    const r = latest.get(user);
    if (r?.state === "CHANGES_REQUESTED") {
      reasons.push("changes_requested");
      evidence.push(
        makeEvidence(
          now,
          `GET /repos/${obs.owner}/${obs.name}/pulls/${prNumber}/reviews`,
          EvidenceMethod.APIRead,
          `latest review by ${user} on PR #${prNumber} requests changes`,
          Confidence.Confirmed,
        ),
      );
      break;
    }
  }

  // review-wait: reviewers were requested long ago and nobody has reviewed at
  // all. Whether the review is *required* cannot be observed with read-only
  // credentials, so the reason is an inference — and it only applies when
  // nothing else explains the stop.
  const requestedCount = d.full?.requested_reviewers?.length ?? 0;
  if (reasons.length === 0 && d.full !== null && requestedCount > 0 && d.reviews.length === 0) {
    const ageDays = Math.trunc(
      (now.getTime() - parseTimestampOrZero(pr.created_at).getTime()) / MS_PER_DAY,
    );
    if (ageDays > REVIEW_WAIT_GRACE_DAYS) {
      reasons.push("review_pending");
      evidence.push(
        makeEvidence(
          now,
          `GET /repos/${obs.owner}/${obs.name}/pulls/${prNumber}`,
          EvidenceMethod.APIRead,
          `PR #${prNumber} has ${requestedCount} requested reviewer(s), no submitted review, and has been open for ${ageDays} days`,
          Confidence.Confirmed,
        ),
        makeEvidence(
          now,
          "rule:review_wait_inference",
          EvidenceMethod.Inference,
          "prolonged reviewer-requested silence suggests the PR is waiting on review; whether that review is required cannot be observed with read-only credentials",
          Confidence.Inferred,
        ),
      );
    }
  }

  return { reasons, evidence };
}

/**
 * Maps Dependabot branch-name namespaces to dependabot.yml package-ecosystem
 * vocabulary (adapter parse knowledge).
 */
const BRANCH_NAMESPACE_ECOSYSTEM: Readonly<Record<string, string>> = {
  npm_and_yarn: "npm",
  go_modules: "gomod",
  pip: "pip",
  github_actions: "github-actions",
  docker: "docker",
  cargo: "cargo",
  bundler: "bundler",
  composer: "composer",
  maven: "maven",
  gradle: "gradle",
};

function manifestForVersionUpdate(obs: Observation, p: ParsedPR): string {
  const ref = p.pr.head?.ref ?? "";
  const parts = ref.split("/");
  const namespace = parts[1];
  if (
    parts.length >= 2 &&
    parts[0] === "dependabot" &&
    namespace !== undefined &&
    Object.hasOwn(BRANCH_NAMESPACE_ECOSYSTEM, namespace)
  ) {
    const eco = BRANCH_NAMESPACE_ECOSYSTEM[namespace];
    if (eco !== undefined && eco !== "") {
      for (const m of detectManifests(obs.treePaths)) {
        if (m.ecosystem === eco && manifestDirectory(m) === p.directory) {
          return m.path;
        }
      }
    }
  }
  return p.directory;
}

function versionUpdates(
  nowFn: () => Date,
  obs: Observation,
  used: ReadonlySet<number>,
): ExpectedUpdate[] {
  const pullsRoute = `GET /repos/${obs.owner}/${obs.name}/pulls?state=open`;
  const updates: ExpectedUpdate[] = [];

  for (const pr of obs.openPRs) {
    const prNumber = pr.number ?? 0;
    if (used.has(prNumber)) {
      continue;
    }
    const p = parseBumpTitle(pr);
    if (p === null) {
      continue;
    }
    const ageDays = prAgeDays(nowFn(), pr);
    const evidence: Evidence[] = [
      makeEvidence(
        nowFn(),
        pullsRoute,
        EvidenceMethod.Parse,
        `open Dependabot pull request #${prNumber} bumps ${p.dependency} from ${p.fromVersion} to ${p.toVersion}, open for ${ageDays} days`,
        Confidence.Confirmed,
      ),
    ];

    let state: LifecycleState = LifecycleState.UpdateOpen;
    let detail = `open Dependabot PR #${prNumber} proposes ${p.fromVersion} -> ${p.toVersion} (open for ${ageDays} days)`;
    const { reasons, evidence: reasonEvidence } = blockedReasons(nowFn(), obs, pr);
    if (reasons.length > 0) {
      state = LifecycleState.Blocked;
      detail = `Dependabot PR #${prNumber} is stopped after ${ageDays} days: ${reasons.join(", ")}`;
      evidence.push(...reasonEvidence);
    }

    updates.push({
      manifest: manifestForVersionUpdate(obs, p),
      dependency: p.dependency,
      state,
      pr_age_days: ageDays,
      ...(reasons.length > 0 ? { blocked_reasons: reasons } : {}),
      detail,
      confidence: weakestLink(evidence),
      evidence,
    });
  }

  return updates;
}

function advisoryUpdates(
  nowFn: () => Date,
  obs: Observation,
): { updates: ExpectedUpdate[]; used: Set<number> } {
  const grouped = new Map<string, { id: UpdateIdentity; alerts: GitHubDependabotAlert[] }>();
  for (const a of obs.openAlerts) {
    const id = alertIdentity(a);
    const key = identityKey(id);
    const existing = grouped.get(key);
    if (existing === undefined) {
      grouped.set(key, { id, alerts: [a] });
    } else {
      existing.alerts.push(a);
    }
  }

  const alertsRoute = `GET /repos/${obs.owner}/${obs.name}/dependabot/alerts?state=open`;
  const pullsRoute = `GET /repos/${obs.owner}/${obs.name}/pulls?state=open`;

  const updates: ExpectedUpdate[] = [];
  const used = new Set<number>();

  for (const { id, alerts } of grouped.values()) {
    const advisoryIDs: string[] = [];
    let hasFix = false;
    const evidence: Evidence[] = [];

    for (const a of alerts) {
      const ghsa = a.security_advisory?.ghsa_id ?? "";
      advisoryIDs.push(ghsa);
      const severity = a.security_vulnerability?.severity ?? "";
      let desc = `open Dependabot alert #${a.number ?? 0} (${ghsa}, severity ${severity}) on ${id.dependency} in ${id.manifest}`;
      const patched = a.security_vulnerability?.first_patched_version?.identifier ?? "";
      if (patched !== "") {
        hasFix = true;
        desc += `, first patched version ${patched}`;
      } else {
        desc += ", no patched version released";
      }
      evidence.push(makeEvidence(nowFn(), alertsRoute, EvidenceMethod.APIRead, desc, Confidence.Confirmed));
    }

    const matched = findOpenBotPR(obs.openPRs, id.dependency, directoryOf(id.manifest));

    let state: LifecycleState;
    let detail: string;
    let blocked: string[] = [];
    let ageDays: number | undefined;

    if (!hasFix) {
      state = LifecycleState.FixUnavailable;
      detail = "an advisory is open but no compatible fixed version has been released";
    } else if (matched === null) {
      const merged = findMergedBotPR(obs.closedPRs, id.dependency, directoryOf(id.manifest));
      if (merged !== null) {
        evidence.push(mergedPREvidence(nowFn(), obs, merged, id.dependency));
        const elapsedMs = nowFn().getTime() - parseTimestampOrZero(merged.pr.merged_at).getTime();
        if (elapsedMs > MERGE_REEVALUATION_GRACE_MS) {
          state = LifecycleState.MergedNotEffective;
          detail = `Dependabot PR #${merged.pr.number ?? 0} was merged but the advisory is still open on the current default branch (reverted, or the resolution regressed)`;
          evidence.push(
            makeEvidence(
              nowFn(),
              alertsRoute,
              EvidenceMethod.APIRead,
              "the alert remains open although GitHub re-evaluates default-branch manifests on push; the fix is not effective",
              Confidence.Confirmed,
            ),
          );
        } else {
          state = LifecycleState.Pending;
          const hoursAgo = Math.trunc(elapsedMs / MS_PER_HOUR);
          detail = `Dependabot PR #${merged.pr.number ?? 0} was merged ${hoursAgo}h ago; awaiting GitHub's re-evaluation of the default branch before judging effectiveness`;
          evidence.push(
            makeEvidence(
              nowFn(),
              alertsRoute,
              EvidenceMethod.APIRead,
              "the alert is still open; GitHub's post-merge re-evaluation is given a grace period before judging merged_not_effective",
              Confidence.Confirmed,
            ),
          );
        }
      } else {
        state = LifecycleState.Pending;
        detail = "a security fix is available but no Dependabot PR exists yet";
        evidence.push(
          makeEvidence(
            nowFn(),
            pullsRoute,
            EvidenceMethod.APIRead,
            `no open Dependabot pull request proposes an update for ${id.dependency} in ${id.manifest}`,
            Confidence.Confirmed,
          ),
        );
      }
    } else {
      const matchedNumber = matched.pr.number ?? 0;
      used.add(matchedNumber);
      const age = prAgeDays(nowFn(), matched.pr);
      ageDays = age;
      evidence.push(
        makeEvidence(
          nowFn(),
          pullsRoute,
          EvidenceMethod.Parse,
          `open Dependabot pull request #${matchedNumber} bumps ${id.dependency} to ${matched.toVersion}, open for ${age} days`,
          Confidence.Confirmed,
        ),
      );
      const result = blockedReasons(nowFn(), obs, matched.pr);
      blocked = result.reasons;
      if (blocked.length > 0) {
        state = LifecycleState.Blocked;
        detail = `Dependabot PR #${matchedNumber} for the security update is stopped after ${age} days: ${blocked.join(", ")}`;
        evidence.push(...result.evidence);
      } else {
        state = LifecycleState.UpdateOpen;
        detail = `open Dependabot PR #${matchedNumber} proposes ${matched.fromVersion} -> ${matched.toVersion} (open for ${age} days)`;
      }
    }

    updates.push({
      manifest: id.manifest,
      dependency: id.dependency,
      ...(advisoryIDs.length > 0 ? { advisory_ids: advisoryIDs } : {}),
      state,
      ...(ageDays !== undefined ? { pr_age_days: ageDays } : {}),
      ...(blocked.length > 0 ? { blocked_reasons: blocked } : {}),
      detail,
      confidence: weakestLink(evidence),
      evidence,
    });
  }

  return { updates, used };
}

function effectiveUpdates(nowFn: () => Date, obs: Observation): ExpectedUpdate[] {
  const stillOpen = new Set<string>();
  for (const a of obs.openAlerts) {
    stillOpen.add(identityKey(alertIdentity(a)));
  }

  const alertsRoute = `GET /repos/${obs.owner}/${obs.name}/dependabot/alerts?state=fixed`;
  const seen = new Set<string>();
  const updates: ExpectedUpdate[] = [];

  for (const a of obs.fixedAlerts) {
    const id = alertIdentity(a);
    const key = identityKey(id);
    if (seen.has(key) || stillOpen.has(key)) {
      continue;
    }
    seen.add(key);

    const merged = findMergedBotPR(obs.closedPRs, id.dependency, directoryOf(id.manifest));
    if (merged === null) {
      continue;
    }

    const ghsa = a.security_advisory?.ghsa_id ?? "";
    const fixedAtStr = formatRFC3339Seconds(parseTimestampOrZero(a.fixed_at));
    const evidence: Evidence[] = [
      mergedPREvidence(nowFn(), obs, merged, id.dependency),
      makeEvidence(
        nowFn(),
        alertsRoute,
        EvidenceMethod.APIRead,
        `alert #${a.number ?? 0} (${ghsa}) was resolved by GitHub's default-branch re-evaluation at ${fixedAtStr}`,
        Confidence.Confirmed,
      ),
    ];

    updates.push({
      manifest: id.manifest,
      dependency: id.dependency,
      advisory_ids: [ghsa],
      state: LifecycleState.Effective,
      detail: `security update reached the current default branch (alert resolved ${fixedAtStr})`,
      confidence: weakestLink(evidence),
      evidence,
    });
  }

  return updates;
}

export function judgeExpectedUpdates(nowFn: () => Date, obs: Observation): ExpectedUpdate[] {
  const { updates: advisory, used } = advisoryUpdates(nowFn, obs);
  const version = versionUpdates(nowFn, obs, used);
  const effective = effectiveUpdates(nowFn, obs);
  return [...advisory, ...version, ...effective];
}

/**
 * Computes derived vulnerable_unpatched findings from non-effective
 * advisory-linked ExpectedUpdates.
 */
export function deriveVulnerable(nowFn: () => Date, updates: readonly ExpectedUpdate[]): Finding[] {
  const findings: Finding[] = [];
  for (const u of updates) {
    if (!u.advisory_ids || u.advisory_ids.length === 0 || u.state === LifecycleState.Effective) {
      continue;
    }
    const advisories = u.advisory_ids.join(", ");
    const evidence: Evidence[] = [
      {
        source: "rule:vulnerable_unpatched",
        method: EvidenceMethod.Derivation,
        description: `advisory-linked expected update for ${u.dependency} in ${u.manifest} is in state ${u.state}, not effective, so the default branch still carries ${advisories}`,
        confidence: u.confidence,
        observed_at: formatRFC3339(nowFn()),
      },
    ];
    findings.push({
      type: FindingType.VulnerableUnpatched,
      subject: {
        kind: SubjectKind.ExpectedUpdate,
        id: `${u.manifest}:${u.dependency}`,
      },
      derived: true,
      confidence: u.confidence,
      detail: `unfixed vulnerability remains on the default branch: ${advisories}`,
      evidence,
    });
  }
  return findings;
}
