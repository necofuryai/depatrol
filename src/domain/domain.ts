/**
 * depatrol's two-layer domain model: coexisting Findings and the
 * ExpectedUpdate lifecycle, both backed by Evidence with binary confidence.
 * Vocabulary follows CONTEXT.md; structure follows ADR 0005.
 */

/**
 * Confidence is binary by decision: confirmed (directly observed) or
 * inferred (estimated). No numeric scores.
 */
export const Confidence = {
  Confirmed: "confirmed",
  Inferred: "inferred",
} as const;
export type Confidence = (typeof Confidence)[keyof typeof Confidence];

/**
 * EvidenceMethod says how an observation was made.
 */
export const EvidenceMethod = {
  /** A field read directly from an API response. */
  APIRead: "api_read",
  /** Interpreted from bot output (titles, branch names). */
  Parse: "parse",
  /** Estimated from indirect signals. */
  Inference: "inference",
  /** Computed from other judgments. */
  Derivation: "derivation",
} as const;
export type EvidenceMethod = (typeof EvidenceMethod)[keyof typeof EvidenceMethod];

/**
 * Evidence is a single first-class observation backing a judgment.
 */
export interface Evidence {
  /**
   * Identifies where the observation came from, e.g. an API route or the name
   * of an inference rule.
   */
  source: string;
  method: EvidenceMethod;
  description: string;
  confidence: Confidence;
  /** RFC3339 UTC timestamp string (Go time.Time JSON compatible, Z suffix). */
  observed_at: string;
}

/**
 * Derives a judgment's confidence from its evidence: one inferred link makes
 * the whole judgment inferred. There is no promotion.
 */
export function weakestLink(evidence: readonly Evidence[]): Confidence {
  for (const e of evidence) {
    if (e.confidence === Confidence.Inferred) {
      return Confidence.Inferred;
    }
  }
  return Confidence.Confirmed;
}

/**
 * SubjectKind names the kinds of things a Finding can be attached to.
 */
export const SubjectKind = {
  Manifest: "manifest",
  BotConfig: "bot_config",
  ExpectedUpdate: "expected_update",
} as const;
export type SubjectKind = (typeof SubjectKind)[keyof typeof SubjectKind];

/**
 * Subject is what a Finding is attached to.
 */
export interface Subject {
  kind: SubjectKind;
  id: string;
}

export const FindingType = {
  CoverageGap: "coverage_gap",
  PausedOrStalled: "paused_or_stalled",
  /**
   * Never stored as a primary judgment: derived from advisory-linked
   * ExpectedUpdates that are not effective.
   */
  VulnerableUnpatched: "vulnerable_unpatched",
} as const;
export type FindingType = (typeof FindingType)[keyof typeof FindingType];

/**
 * Finding is a verified observation attached to a subject. Findings coexist;
 * they are not exclusive states.
 */
export interface Finding {
  type: FindingType;
  subject: Subject;
  /** Present and true only for derived findings; omitted when false (Go omitempty). */
  derived?: true;
  confidence: Confidence;
  detail: string;
  evidence: Evidence[];
}

/**
 * LifecycleState is the transition position of an ExpectedUpdate.
 */
export const LifecycleState = {
  Pending: "pending",
  UpdateOpen: "update_open",
  Blocked: "blocked",
  FixUnavailable: "fix_unavailable",
  Effective: "effective",
  MergedNotEffective: "merged_not_effective",
} as const;
export type LifecycleState = (typeof LifecycleState)[keyof typeof LifecycleState];

/**
 * ExpectedUpdate is the fact "dependency X in manifest M should move to a
 * safe/newer version", identified by (repository, manifest, dependency).
 * PRs and alerts are evidence linked to it, not the entity itself.
 */
export interface ExpectedUpdate {
  manifest: string;
  dependency: string;
  /** Omitted when empty (Go omitempty). */
  advisory_ids?: string[];
  state: LifecycleState;
  /**
   * Present while an open pull request is the update's observable work item.
   * An explicit age of 0 is preserved in JSON; omitted only when undefined.
   */
  pr_age_days?: number;
  /** Omitted when empty (Go omitempty). */
  blocked_reasons?: string[];
  detail: string;
  confidence: Confidence;
  evidence: Evidence[];
}

/**
 * Published-vocabulary worst-first severity order from CONTEXT.md.
 * Labels outside M0's scope simply never occur yet.
 */
export const SEVERITY_ORDER = [
  "sla_breached",
  "vulnerable_unpatched",
  "merged_not_effective",
  "fix_unavailable",
  "blocked",
  "paused_or_stalled",
  "coverage_gap",
  "policy_drift",
  "update_open",
  "pending",
] as const;

export type RollupLabel = (typeof SEVERITY_ORDER)[number] | "healthy";

/**
 * Rollup labels a repository with its most severe present condition and counts
 * every condition. It is always derived, never stored.
 */
export interface Rollup {
  label: RollupLabel;
  counts: Record<string, number>;
}

/**
 * Derives the rollup from both layers. `effective` is counted (healthy
 * repositories are explained with the same evidence as unhealthy ones) but
 * never becomes the label: it is a terminal success state.
 */
export function computeRollup(
  findings: readonly Finding[],
  updates: readonly ExpectedUpdate[],
): Rollup {
  const tally = new Map<string, number>();
  for (const f of findings) {
    tally.set(f.type, (tally.get(f.type) ?? 0) + 1);
  }
  for (const u of updates) {
    tally.set(u.state, (tally.get(u.state) ?? 0) + 1);
  }

  // Sort keys in UTF-8/codepoint order to match Go's encoding/json map output.
  const counts: Record<string, number> = {};
  const sortedKeys = [...tally.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const key of sortedKeys) {
    const count = tally.get(key);
    if (count !== undefined) {
      counts[key] = count;
    }
  }

  for (const label of SEVERITY_ORDER) {
    if ((tally.get(label) ?? 0) > 0) {
      return { label, counts };
    }
  }
  return { label: "healthy", counts };
}

/**
 * RepositoryReport is one repository's snapshot.
 */
export interface RepositoryReport {
  repository: string;
  default_branch: string;
  rollup: Rollup;
  findings: Finding[];
  expected_updates: ExpectedUpdate[];
}

/**
 * ScanError records a repository that could not be scanned. It is not a
 * Finding: inability to judge must not be confused with an anomaly.
 */
export interface ScanError {
  repository: string;
  stage: string;
  message: string;
}

/**
 * Target records what the scan was asked to cover, so a repository that
 * silently fell out of the scan is detectable from the report alone.
 */
export interface Target {
  /** Omitted when empty (Go omitempty). */
  org?: string;
  /** Omitted when empty (Go omitempty). */
  repos?: string[];
}

/**
 * Report is the stateless snapshot a scan produces. JSON is the primary
 * contract; the table output is a projection of this.
 */
export interface Report {
  /** RFC3339 UTC timestamp string (Go time.Time JSON compatible, Z suffix). */
  observed_at: string;
  target: Target;
  repositories: RepositoryReport[];
  scan_errors: ScanError[];
}

/**
 * Formats a Date as an RFC3339 UTC timestamp string matching Go's
 * time.Time.MarshalJSON() output: "2026-08-01T12:00:00Z" when fractional
 * seconds are zero, or with trailing fractional zeros trimmed otherwise.
 */
export function formatRFC3339(date: Date): string {
  return date
    .toISOString()
    .replace(/(\.\d*?)0+Z$/, "$1Z")
    .replace(/\.Z$/, "Z");
}

function normalizeEvidence(evidence: Evidence): Evidence {
  return {
    source: evidence.source,
    method: evidence.method,
    description: evidence.description,
    confidence: evidence.confidence,
    observed_at: evidence.observed_at,
  };
}

function normalizeSubject(subject: Subject): Subject {
  return {
    kind: subject.kind,
    id: subject.id,
  };
}

function normalizeScanError(error: ScanError): ScanError {
  return {
    repository: error.repository,
    stage: error.stage,
    message: error.message,
  };
}

/**
 * Normalizes a Finding into canonical Go-compatible JSON field order, omitting
 * `derived` unless explicitly true.
 */
export function normalizeFinding(finding: Finding): Finding {
  return {
    type: finding.type,
    subject: normalizeSubject(finding.subject),
    ...(finding.derived === true ? { derived: true as const } : {}),
    confidence: finding.confidence,
    detail: finding.detail,
    evidence: finding.evidence.map(normalizeEvidence),
  };
}

/**
 * Normalizes an ExpectedUpdate into canonical Go-compatible JSON field order,
 * omitting empty `advisory_ids` / `blocked_reasons` while preserving an
 * explicit `pr_age_days` of 0.
 */
export function normalizeExpectedUpdate(update: ExpectedUpdate): ExpectedUpdate {
  return {
    manifest: update.manifest,
    dependency: update.dependency,
    ...(update.advisory_ids !== undefined && update.advisory_ids.length > 0
      ? { advisory_ids: [...update.advisory_ids] }
      : {}),
    state: update.state,
    ...(update.pr_age_days !== undefined
      ? { pr_age_days: Object.is(update.pr_age_days, -0) ? 0 : update.pr_age_days }
      : {}),
    ...(update.blocked_reasons !== undefined && update.blocked_reasons.length > 0
      ? { blocked_reasons: [...update.blocked_reasons] }
      : {}),
    detail: update.detail,
    confidence: update.confidence,
    evidence: update.evidence.map(normalizeEvidence),
  };
}

/**
 * Normalizes a Rollup so `counts` keys are sorted in UTF-8/codepoint order.
 */
export function normalizeRollup(rollup: Rollup): Rollup {
  const counts: Record<string, number> = {};
  const sortedKeys = Object.keys(rollup.counts).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const key of sortedKeys) {
    const value = rollup.counts[key];
    if (value !== undefined) {
      counts[key] = value;
    }
  }
  return {
    label: rollup.label,
    counts,
  };
}

/**
 * Normalizes a Target into canonical Go-compatible JSON form, omitting empty
 * `org` and empty `repos`.
 */
export function normalizeTarget(target: Target): Target {
  return {
    ...(target.org !== undefined && target.org !== "" ? { org: target.org } : {}),
    ...(target.repos !== undefined && target.repos.length > 0
      ? { repos: [...target.repos] }
      : {}),
  };
}

/**
 * Normalizes a RepositoryReport into canonical Go-compatible JSON field order.
 */
export function normalizeRepositoryReport(repo: RepositoryReport): RepositoryReport {
  return {
    repository: repo.repository,
    default_branch: repo.default_branch,
    rollup: normalizeRollup(repo.rollup),
    findings: repo.findings.map(normalizeFinding),
    expected_updates: repo.expected_updates.map(normalizeExpectedUpdate),
  };
}

/**
 * Normalizes a Report into canonical Go-compatible JSON field order and
 * omitempty semantics.
 */
export function normalizeReport(report: Report): Report {
  return {
    observed_at: report.observed_at,
    target: normalizeTarget(report.target),
    repositories: report.repositories.map(normalizeRepositoryReport),
    scan_errors: report.scan_errors.map(normalizeScanError),
  };
}

/**
 * Serializes a Report to 2-space indented JSON with a trailing newline,
 * matching Go's json.Encoder (SetIndent("", "  ")).
 */
export function serializeReport(report: Report): string {
  return `${JSON.stringify(normalizeReport(report), null, 2)}\n`;
}
