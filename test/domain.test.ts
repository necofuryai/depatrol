import { describe, expect, test } from "bun:test";
import {
  Confidence,
  EvidenceMethod,
  FindingType,
  LifecycleState,
  SEVERITY_ORDER,
  SubjectKind,
  computeRollup,
  formatRFC3339,
  normalizeExpectedUpdate,
  normalizeFinding,
  normalizeReport,
  normalizeTarget,
  serializeReport,
  weakestLink,
  type Evidence,
  type ExpectedUpdate,
  type Finding,
  type Report,
  type RollupLabel,
} from "../src/domain/domain.ts";

const FIXED_TIME = "2026-08-01T12:00:00Z";

function makeEvidence(confidence: Confidence, source = "GET /repos/acme/app"): Evidence {
  return {
    source,
    method: confidence === Confidence.Inferred ? EvidenceMethod.Inference : EvidenceMethod.APIRead,
    description: `observed (${confidence})`,
    confidence,
    observed_at: FIXED_TIME,
  };
}

function makeFinding(type: FindingType, overrides: Partial<Finding> = {}): Finding {
  const evidence = overrides.evidence ?? [makeEvidence(Confidence.Confirmed)];
  return {
    type,
    subject: { kind: SubjectKind.Manifest, id: "package.json" },
    confidence: weakestLink(evidence),
    detail: `finding ${type}`,
    evidence,
    ...overrides,
  };
}

function makeUpdate(state: LifecycleState, overrides: Partial<ExpectedUpdate> = {}): ExpectedUpdate {
  const evidence = overrides.evidence ?? [makeEvidence(Confidence.Confirmed)];
  return {
    manifest: "package.json",
    dependency: "lodash",
    state,
    detail: `update ${state}`,
    confidence: weakestLink(evidence),
    evidence,
    ...overrides,
  };
}

describe("domain vocabulary constants", () => {
  test("match CONTEXT.md and Go domain.go string literals", () => {
    expect(Confidence).toEqual({
      Confirmed: "confirmed",
      Inferred: "inferred",
    });
    expect(EvidenceMethod).toEqual({
      APIRead: "api_read",
      Parse: "parse",
      Inference: "inference",
      Derivation: "derivation",
    });
    expect(SubjectKind).toEqual({
      Manifest: "manifest",
      BotConfig: "bot_config",
      ExpectedUpdate: "expected_update",
    });
    expect(FindingType).toEqual({
      CoverageGap: "coverage_gap",
      PausedOrStalled: "paused_or_stalled",
      VulnerableUnpatched: "vulnerable_unpatched",
    });
    expect(LifecycleState).toEqual({
      Pending: "pending",
      UpdateOpen: "update_open",
      Blocked: "blocked",
      FixUnavailable: "fix_unavailable",
      Effective: "effective",
      MergedNotEffective: "merged_not_effective",
    });
    expect([...SEVERITY_ORDER]).toEqual([
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
    ]);
  });
});

describe("weakestLink", () => {
  test("returns confirmed when all evidence is confirmed", () => {
    expect(
      weakestLink([
        makeEvidence(Confidence.Confirmed, "route-1"),
        makeEvidence(Confidence.Confirmed, "route-2"),
      ]),
    ).toBe(Confidence.Confirmed);
  });

  test("returns inferred when any single evidence item is inferred", () => {
    expect(weakestLink([makeEvidence(Confidence.Inferred)])).toBe(Confidence.Inferred);
    expect(
      weakestLink([
        makeEvidence(Confidence.Inferred, "first"),
        makeEvidence(Confidence.Confirmed, "second"),
      ]),
    ).toBe(Confidence.Inferred);
    expect(
      weakestLink([
        makeEvidence(Confidence.Confirmed, "first"),
        makeEvidence(Confidence.Inferred, "middle"),
        makeEvidence(Confidence.Confirmed, "last"),
      ]),
    ).toBe(Confidence.Inferred);
    expect(
      weakestLink([
        makeEvidence(Confidence.Confirmed, "first"),
        makeEvidence(Confidence.Confirmed, "second"),
        makeEvidence(Confidence.Inferred, "last"),
      ]),
    ).toBe(Confidence.Inferred);
  });

  test("returns confirmed for an empty evidence slice (Go WeakestLink parity)", () => {
    expect(weakestLink([])).toBe(Confidence.Confirmed);
  });
});

describe("computeRollup", () => {
  test("returns healthy with empty counts when there are no findings or updates", () => {
    const rollup = computeRollup([], []);
    expect(rollup).toEqual({ label: "healthy", counts: {} });
  });

  test("counts effective updates while keeping label healthy", () => {
    const rollup = computeRollup([], [
      makeUpdate(LifecycleState.Effective, { dependency: "lodash" }),
      makeUpdate(LifecycleState.Effective, { dependency: "axios" }),
    ]);
    expect(rollup).toEqual({
      label: "healthy",
      counts: { effective: 2 },
    });
  });

  test("preserves effective in counts alongside an active condition", () => {
    const rollup = computeRollup([], [
      makeUpdate(LifecycleState.Effective, { dependency: "lodash" }),
      makeUpdate(LifecycleState.Pending, { dependency: "axios" }),
    ]);
    expect(rollup).toEqual({
      label: "pending",
      counts: { effective: 1, pending: 1 },
    });
  });

  test("follows the complete CONTEXT.md severity order worst-first", () => {
    // Build a synthetic pair of findings/updates for each label in SEVERITY_ORDER.
    const findingLabels = new Set<string>([
      "sla_breached",
      "vulnerable_unpatched",
      "paused_or_stalled",
      "coverage_gap",
      "policy_drift",
    ]);

    const asInput = (label: (typeof SEVERITY_ORDER)[number]) => {
      if (findingLabels.has(label)) {
        return { findings: [makeFinding(label as FindingType)], updates: [] as ExpectedUpdate[] };
      }
      return { findings: [] as Finding[], updates: [makeUpdate(label as LifecycleState)] };
    };

    // Every single label beats all lower-severity labels combined.
    for (let i = 0; i < SEVERITY_ORDER.length; i++) {
      const winner = SEVERITY_ORDER[i]!;
      const findings: Finding[] = [];
      const updates: ExpectedUpdate[] = [makeUpdate(LifecycleState.Effective)];
      for (let j = i; j < SEVERITY_ORDER.length; j++) {
        const entry = asInput(SEVERITY_ORDER[j]!);
        findings.push(...entry.findings);
        updates.push(...entry.updates);
      }

      const rollup = computeRollup(findings, updates);
      expect(rollup.label).toBe<RollupLabel>(winner);
      expect(rollup.counts[winner]).toBe(1);
      expect(rollup.counts["effective"]).toBe(1);
    }
  });

  test("aggregates duplicate conditions and sorts count keys lexicographically", () => {
    const rollup = computeRollup(
      [
        makeFinding(FindingType.VulnerableUnpatched, { derived: true }),
        makeFinding(FindingType.CoverageGap),
        makeFinding(FindingType.CoverageGap),
      ],
      [
        makeUpdate(LifecycleState.Blocked),
        makeUpdate(LifecycleState.UpdateOpen),
        makeUpdate(LifecycleState.Blocked),
      ],
    );

    expect(rollup).toEqual({
      label: "vulnerable_unpatched",
      counts: {
        blocked: 2,
        coverage_gap: 2,
        update_open: 1,
        vulnerable_unpatched: 1,
      },
    });
    expect(Object.keys(rollup.counts)).toEqual([
      "blocked",
      "coverage_gap",
      "update_open",
      "vulnerable_unpatched",
    ]);
  });
});

describe("formatRFC3339", () => {
  test("omits fractional seconds when milliseconds are zero", () => {
    expect(formatRFC3339(new Date("2026-08-01T12:00:00.000Z"))).toBe("2026-08-01T12:00:00Z");
    expect(formatRFC3339(new Date("2026-08-01T12:00:10.000Z"))).toBe("2026-08-01T12:00:10Z");
    expect(formatRFC3339(new Date("2026-08-01T10:20:30.000Z"))).toBe("2026-08-01T10:20:30Z");
  });

  test("trims trailing fractional zeros like Go time.Time.MarshalJSON", () => {
    expect(formatRFC3339(new Date("2026-08-01T12:00:00.100Z"))).toBe("2026-08-01T12:00:00.1Z");
    expect(formatRFC3339(new Date("2026-08-01T12:00:00.120Z"))).toBe("2026-08-01T12:00:00.12Z");
    expect(formatRFC3339(new Date("2026-08-01T12:00:00.050Z"))).toBe("2026-08-01T12:00:00.05Z");
    expect(formatRFC3339(new Date("2026-08-01T12:00:00.123Z"))).toBe("2026-08-01T12:00:00.123Z");
  });

  test("throws RangeError for an invalid Date", () => {
    expect(() => formatRFC3339(new Date("not-a-date"))).toThrow(RangeError);
  });
});

describe("JSON serialization contract (Go encoding/json parity)", () => {
  test("preserves pr_age_days: 0 and omits pr_age_days when undefined", () => {
    const zeroAge = normalizeExpectedUpdate(
      makeUpdate(LifecycleState.UpdateOpen, { pr_age_days: 0 }),
    );
    const parsedZero = JSON.parse(JSON.stringify(zeroAge)) as Record<string, unknown>;
    expect("pr_age_days" in parsedZero).toBe(true);
    expect(parsedZero["pr_age_days"]).toBe(0);

    const negZeroAge = normalizeExpectedUpdate(
      makeUpdate(LifecycleState.UpdateOpen, { pr_age_days: -0 }),
    );
    expect(Object.is(negZeroAge.pr_age_days, 0)).toBe(true);

    const noAge = normalizeExpectedUpdate(makeUpdate(LifecycleState.Pending));
    const parsedNone = JSON.parse(JSON.stringify(noAge)) as Record<string, unknown>;
    expect("pr_age_days" in parsedNone).toBe(false);
  });

  test("omits derived unless explicitly true (Go omitempty)", () => {
    const primary = normalizeFinding(makeFinding(FindingType.CoverageGap));
    expect("derived" in primary).toBe(false);

    const runtimeFalse = normalizeFinding({
      ...makeFinding(FindingType.CoverageGap),
      derived: false as unknown as true,
    });
    expect("derived" in runtimeFalse).toBe(false);

    const derived = normalizeFinding(
      makeFinding(FindingType.VulnerableUnpatched, { derived: true }),
    );
    expect(derived.derived).toBe(true);
    expect(Object.keys(derived)).toEqual([
      "type",
      "subject",
      "derived",
      "confidence",
      "detail",
      "evidence",
    ]);
  });

  test("omits empty advisory_ids, blocked_reasons, org, and repos (Go omitempty)", () => {
    const update = normalizeExpectedUpdate(
      makeUpdate(LifecycleState.UpdateOpen, {
        advisory_ids: [],
        blocked_reasons: [],
        pr_age_days: 3,
      }),
    );
    const parsedUpdate = JSON.parse(JSON.stringify(update)) as Record<string, unknown>;
    expect("advisory_ids" in parsedUpdate).toBe(false);
    expect("blocked_reasons" in parsedUpdate).toBe(false);
    expect(parsedUpdate["pr_age_days"]).toBe(3);

    expect(normalizeTarget({ org: "", repos: [] })).toEqual({});
    expect(Object.keys(normalizeTarget({ org: "", repos: ["acme/app"] }))).toEqual(["repos"]);
    expect(Object.keys(normalizeTarget({ org: "acme", repos: [] }))).toEqual(["org"]);
    expect(Object.keys(normalizeTarget({ org: "acme", repos: ["acme/extra"] }))).toEqual([
      "org",
      "repos",
    ]);
  });

  test("keeps empty arrays as [] and empty counts as {} (never null or omitted)", () => {
    const emptyReport: Report = {
      observed_at: FIXED_TIME,
      target: { repos: ["acme/empty"] },
      repositories: [
        {
          repository: "acme/empty",
          default_branch: "main",
          rollup: computeRollup([], []),
          findings: [],
          expected_updates: [],
        },
      ],
      scan_errors: [],
    };

    const raw = serializeReport(emptyReport);
    expect(raw.endsWith("\n")).toBe(true);

    const parsed = JSON.parse(raw) as Report;
    expect(parsed).toEqual({
      observed_at: "2026-08-01T12:00:00Z",
      target: { repos: ["acme/empty"] },
      repositories: [
        {
          repository: "acme/empty",
          default_branch: "main",
          rollup: { label: "healthy", counts: {} },
          findings: [],
          expected_updates: [],
        },
      ],
      scan_errors: [],
    });

    // Empty top-level repositories array (e.g., all targets failed) stays []
    const failedOnly: Report = {
      observed_at: FIXED_TIME,
      target: { repos: ["acme/broken"] },
      repositories: [],
      scan_errors: [
        {
          repository: "acme/broken",
          stage: "repository",
          message: "404 Not Found",
        },
      ],
    };
    const parsedFailed = JSON.parse(serializeReport(failedOnly)) as Report;
    expect(parsedFailed.repositories).toEqual([]);
    expect(parsedFailed.scan_errors).toHaveLength(1);
  });

  test("preserves Go struct key order across all nested objects", () => {
    const report: Report = {
      observed_at: FIXED_TIME,
      target: { org: "acme", repos: ["acme/extra"] },
      repositories: [
        {
          repository: "acme/app",
          default_branch: "main",
          rollup: {
            label: "vulnerable_unpatched",
            counts: { vulnerable_unpatched: 1, blocked: 1 },
          },
          findings: [
            makeFinding(FindingType.VulnerableUnpatched, {
              derived: true,
              subject: { kind: SubjectKind.ExpectedUpdate, id: "package.json:lodash" },
            }),
          ],
          expected_updates: [
            makeUpdate(LifecycleState.Blocked, {
              advisory_ids: ["GHSA-aaaa-bbbb-cccc"],
              pr_age_days: 0,
              blocked_reasons: ["ci_failing"],
            }),
          ],
        },
      ],
      scan_errors: [
        {
          repository: "acme/broken",
          stage: "tree",
          message: "truncated",
        },
      ],
    };

    const normalized = normalizeReport(report);
    expect(Object.keys(normalized)).toEqual([
      "observed_at",
      "target",
      "repositories",
      "scan_errors",
    ]);
    expect(Object.keys(normalized.target)).toEqual(["org", "repos"]);

    const repo = normalized.repositories[0]!;
    expect(Object.keys(repo)).toEqual([
      "repository",
      "default_branch",
      "rollup",
      "findings",
      "expected_updates",
    ]);
    expect(Object.keys(repo.rollup)).toEqual(["label", "counts"]);
    expect(Object.keys(repo.rollup.counts)).toEqual(["blocked", "vulnerable_unpatched"]);

    const finding = repo.findings[0]!;
    expect(Object.keys(finding)).toEqual([
      "type",
      "subject",
      "derived",
      "confidence",
      "detail",
      "evidence",
    ]);
    expect(Object.keys(finding.subject)).toEqual(["kind", "id"]);
    expect(Object.keys(finding.evidence[0]!)).toEqual([
      "source",
      "method",
      "description",
      "confidence",
      "observed_at",
    ]);

    const update = repo.expected_updates[0]!;
    expect(Object.keys(update)).toEqual([
      "manifest",
      "dependency",
      "advisory_ids",
      "state",
      "pr_age_days",
      "blocked_reasons",
      "detail",
      "confidence",
      "evidence",
    ]);

    const scanErr = normalized.scan_errors[0]!;
    expect(Object.keys(scanErr)).toEqual(["repository", "stage", "message"]);
  });
});
