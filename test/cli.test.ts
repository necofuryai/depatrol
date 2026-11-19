import { describe, expect, test } from "bun:test";
import {
  deduplicateTargets,
  formatTabWriter,
  renderTable,
  run,
  type Writable,
} from "../src/cli/index.ts";
import {
  Confidence,
  EvidenceMethod,
  FindingType,
  LifecycleState,
  SubjectKind,
  type Report,
} from "../src/domain/domain.ts";
import { createCassetteReplayer } from "./helpers/cassette.ts";

// fixedNow makes cooldown and age judgments deterministic. Cassette
// timestamps are written relative to this instant.
const FIXED_NOW = new Date("2026-08-01T12:00:00Z");

// The interfaces below restate the JSON contract independently of the
// production types on purpose: if the contract drifts, these tests fail.
interface ReportJSON {
  observed_at: string;
  target: {
    org?: string;
    repos?: string[];
  };
  repositories: RepositoryJSON[];
  scan_errors: ScanErrorJSON[];
}

interface RepositoryJSON {
  repository: string;
  default_branch: string;
  rollup: RollupJSON;
  findings: FindingJSON[];
  expected_updates: UpdateJSON[];
}

interface RollupJSON {
  label: string;
  counts: Record<string, number>;
}

interface FindingJSON {
  type: string;
  subject: { kind: string; id: string };
  derived?: boolean;
  confidence: string;
  detail: string;
  evidence: EvidenceJSON[];
}

interface UpdateJSON {
  manifest: string;
  dependency: string;
  advisory_ids?: string[];
  state: string;
  pr_age_days?: number;
  blocked_reasons?: string[];
  detail: string;
  confidence: string;
  evidence: EvidenceJSON[];
}

interface EvidenceJSON {
  source: string;
  method: string;
  description: string;
  confidence: string;
  observed_at: string;
}

interface ScanErrorJSON {
  repository: string;
  stage: string;
  message: string;
}

function createBuffer(): Writable & { text(): string } {
  let chunks = "";
  return {
    write(chunk: string) {
      chunks += chunk;
      return true;
    },
    text() {
      return chunks;
    },
  };
}

// runScan drives the real CLI through the project's single seam: a recorded
// HTTP transport and an injected clock.
async function runScan(
  cassetteName: string,
  args: string[],
  env: Record<string, string | undefined> = { GITHUB_TOKEN: "test-token" },
): Promise<{ stdout: string; stderr: string; code: number; usedCount: number }> {
  const replayer = createCassetteReplayer(cassetteName);
  const stdout = createBuffer();
  const stderr = createBuffer();
  const code = await run(["scan", ...args], {
    fetch: replayer.fetch,
    now: () => FIXED_NOW,
    stdout,
    stderr,
    env,
    paceRatePerSec: 0,
  });
  return { stdout: stdout.text(), stderr: stderr.text(), code, usedCount: replayer.usedCount() };
}

async function scanReport(cassetteName: string, ...args: string[]): Promise<ReportJSON> {
  const { stdout, stderr, code } = await runScan(cassetteName, [...args, "--output", "json"]);
  expect(code, `stderr: ${stderr}`).toBe(0);
  expect(stderr).toBe("");
  return JSON.parse(stdout) as ReportJSON;
}

function singleRepo(report: ReportJSON): RepositoryJSON {
  expect(report.scan_errors).toEqual([]);
  expect(report.repositories).toHaveLength(1);
  return report.repositories[0]!;
}

function requireAllEvidence(evidence: EvidenceJSON[], wantConfidence?: string): void {
  expect(evidence.length).toBeGreaterThan(0);
  for (const e of evidence) {
    expect(e.source).not.toBe("");
    expect(e.method).not.toBe("");
    expect(e.description).not.toBe("");
    expect(e.observed_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    if (wantConfidence !== undefined) {
      expect(e.confidence).toBe(wantConfidence);
    }
  }
}

function findFinding(repo: RepositoryJSON, type: string): FindingJSON {
  const found = repo.findings.find((f) => f.type === type);
  expect(found, `no ${type} finding in ${JSON.stringify(repo.findings)}`).toBeDefined();
  return found!;
}

function singleUpdate(repo: RepositoryJSON): UpdateJSON {
  expect(repo.expected_updates).toHaveLength(1);
  return repo.expected_updates[0]!;
}

function findUpdate(repo: RepositoryJSON, dependency: string): UpdateJSON {
  const found = repo.expected_updates.find((u) => u.dependency === dependency);
  expect(found, `no expected update for ${dependency}`).toBeDefined();
  return found!;
}

describe("CLI scan cassette tests (1:1 port of internal/cli/cli_test.go)", () => {
  test("reports coverage_gap for uncovered manifest", async () => {
    const report = await scanReport("coverage_gap", "--repo", "acme/gap");
    const repo = singleRepo(report);

    expect(repo.rollup.label).toBe("coverage_gap");
    expect(repo.rollup.counts.coverage_gap).toBe(1);
    expect(repo.findings).toHaveLength(1);
    const f = repo.findings[0]!;
    expect(f.type).toBe("coverage_gap");
    expect(f.subject).toEqual({ kind: "manifest", id: "package.json" });
    expect(f.confidence).toBe("confirmed");
    requireAllEvidence(f.evidence, "confirmed");
  });

  test("covered manifest is healthy", async () => {
    const report = await scanReport("covered_manifest", "--repo", "acme/covered");
    const repo = singleRepo(report);

    expect(repo.rollup.label).toBe("healthy");
    expect(repo.findings).toEqual([]);
  });

  test("reports paused as confirmed", async () => {
    const report = await scanReport("paused", "--repo", "acme/paused");
    const repo = singleRepo(report);

    expect(repo.rollup.label).toBe("paused_or_stalled");
    const f = findFinding(repo, "paused_or_stalled");
    expect(f.subject.kind).toBe("bot_config");
    expect(f.confidence).toBe("confirmed");
    requireAllEvidence(f.evidence, "confirmed");
  });

  test("infers stalled when no bot output ever observed", async () => {
    const report = await scanReport("stalled", "--repo", "acme/stalled");
    const repo = singleRepo(report);

    expect(repo.rollup.label).toBe("paused_or_stalled");
    const f = findFinding(repo, "paused_or_stalled");
    expect(f.confidence).toBe("inferred");
    requireAllEvidence(f.evidence);

    const confirmed = f.evidence.filter((e) => e.confidence === "confirmed").length;
    const inferred = f.evidence.filter((e) => e.confidence === "inferred").length;
    expect(inferred).toBeGreaterThan(0);
    expect(confirmed).toBeGreaterThan(0);
  });

  test("respects cooldown when judging stall", async () => {
    const report = await scanReport("cooldown_healthy", "--repo", "acme/cooldown");
    const repo = singleRepo(report);

    expect(repo.findings.filter((f) => f.type === "paused_or_stalled")).toEqual([]);
    expect(repo.rollup.label).toBe("healthy");
  });

  test("reports pending for alert without PR", async () => {
    const report = await scanReport("alert_pending", "--repo", "acme/vulnpending");
    const repo = singleRepo(report);

    const u = singleUpdate(repo);
    expect(u.manifest).toBe("package.json");
    expect(u.dependency).toBe("lodash");
    expect(u.advisory_ids).toEqual(["GHSA-aaaa-bbbb-cccc"]);
    expect(u.state).toBe("pending");
    expect(u.confidence).toBe("confirmed");
    requireAllEvidence(u.evidence, "confirmed");

    const derived = findFinding(repo, "vulnerable_unpatched");
    expect(derived.derived).toBe(true);
    expect(repo.rollup.label).toBe("vulnerable_unpatched");
    expect(repo.rollup.counts.pending).toBe(1);
    expect(repo.rollup.counts.vulnerable_unpatched).toBe(1);
  });

  test("reports fix_unavailable", async () => {
    const report = await scanReport("fix_unavailable", "--repo", "acme/nofix");
    const repo = singleRepo(report);

    const u = singleUpdate(repo);
    expect(u.dependency).toBe("leftover");
    expect(u.state).toBe("fix_unavailable");
    requireAllEvidence(u.evidence, "confirmed");

    findFinding(repo, "vulnerable_unpatched");
    expect(repo.rollup.label).toBe("vulnerable_unpatched");
  });

  test("reports version update_open", async () => {
    const report = await scanReport("update_open", "--repo", "acme/rolling");
    const repo = singleRepo(report);

    const u = singleUpdate(repo);
    expect(u.dependency).toBe("axios");
    expect(u.manifest).toBe("package.json");
    expect(u.advisory_ids).toBeUndefined();
    expect(u.state).toBe("update_open");
    expect(u.pr_age_days).toBe(3);
    expect(u.confidence).toBe("confirmed");
    requireAllEvidence(u.evidence, "confirmed");
    expect(repo.rollup.label).toBe("update_open");
  });

  test("explains blocked PRs", async () => {
    const report = await scanReport("blocked", "--repo", "acme/stuck");
    const repo = singleRepo(report);

    expect(repo.expected_updates).toHaveLength(4);
    const cases = [
      { dep: "ci-dep", reason: "ci_failing", confidence: "confirmed" },
      { dep: "conflict-dep", reason: "merge_conflict", confidence: "confirmed" },
      { dep: "review-dep", reason: "changes_requested", confidence: "confirmed" },
      { dep: "wait-dep", reason: "review_pending", confidence: "inferred" },
    ];
    for (const c of cases) {
      const u = findUpdate(repo, c.dep);
      expect(u.state).toBe("blocked");
      expect(u.blocked_reasons).toContain(c.reason);
      expect(u.confidence).toBe(c.confidence);
      requireAllEvidence(u.evidence);
    }
    expect(repo.rollup.label).toBe("blocked");
    expect(repo.rollup.counts.blocked).toBe(4);
  });

  test("confirms effective security fix", async () => {
    const report = await scanReport("effective", "--repo", "acme/fixed");
    const repo = singleRepo(report);

    const u = singleUpdate(repo);
    expect(u.dependency).toBe("lodash");
    expect(u.state).toBe("effective");
    expect(u.confidence).toBe("confirmed");
    requireAllEvidence(u.evidence, "confirmed");
    expect(u.evidence.length).toBeGreaterThanOrEqual(2);

    expect(repo.findings.filter((f) => f.type === "vulnerable_unpatched")).toEqual([]);
    expect(repo.rollup.label).toBe("healthy");
    expect(repo.rollup.counts.effective).toBe(1);
  });

  test("detects merged_not_effective", async () => {
    const report = await scanReport("merged_not_effective", "--repo", "acme/reverted");
    const repo = singleRepo(report);

    const u = singleUpdate(repo);
    expect(u.state).toBe("merged_not_effective");
    expect(u.confidence).toBe("confirmed");
    requireAllEvidence(u.evidence, "confirmed");

    const derived = findFinding(repo, "vulnerable_unpatched");
    expect(derived.derived).toBe(true);
    expect(repo.rollup.label).toBe("vulnerable_unpatched");
    expect(repo.rollup.counts.merged_not_effective).toBe(1);
  });

  test("continues past broken repository", async () => {
    const report = await scanReport(
      "scan_error_continues",
      "--repo",
      "acme/broken",
      "--repo",
      "acme/empty",
    );

    expect(report.repositories).toHaveLength(1);
    expect(report.repositories[0]?.repository).toBe("acme/empty");
    expect(report.scan_errors).toHaveLength(1);
    const e = report.scan_errors[0]!;
    expect(e.repository).toBe("acme/broken");
    expect(e.stage).toBe("repository");
    expect(e.message).not.toBe("");
  });

  test("org scan paginates and skips archived repositories", async () => {
    const report = await scanReport("org_scan", "--org", "acme");

    expect(report.target.org).toBe("acme");
    expect(report.target.repos).toBeUndefined();
    expect(report.scan_errors).toEqual([]);
    expect(report.repositories.map((r) => r.repository)).toEqual(["acme/empty", "acme/empty2"]);
  });

  test("paginates every judgment source", async () => {
    const report = await scanReport("pagination", "--repo", "acme/paged");
    const repo = singleRepo(report);

    const axios = findUpdate(repo, "axios");
    expect(axios.state).toBe("update_open");
    expect(axios.pr_age_days).toBe(3);
    expect(axios.advisory_ids).toEqual(["GHSA-page-open-0001"]);

    const lodash = findUpdate(repo, "lodash");
    expect(lodash.state).toBe("merged_not_effective");

    const reviewDep = findUpdate(repo, "review-dep");
    expect(reviewDep.blocked_reasons).toContain("changes_requested");

    const ciDep = findUpdate(repo, "ci-dep");
    expect(ciDep.blocked_reasons).toContain("ci_failing");
  });

  test("rejects truncated tree instead of judging partial coverage", async () => {
    const report = await scanReport("truncated_tree", "--repo", "acme/truncated");

    expect(report.repositories).toEqual([]);
    expect(report.scan_errors).toHaveLength(1);
    const e = report.scan_errors[0]!;
    expect(e.stage).toBe("tree");
    expect(e.message.toLowerCase()).toContain("truncated");
  });

  test("reports alerts disabled as coverage_gap", async () => {
    const report = await scanReport("alerts_disabled", "--repo", "acme/noalerts");
    const repo = singleRepo(report);

    const f = findFinding(repo, "coverage_gap");
    expect(f.subject).toEqual({ kind: "bot_config", id: "dependabot-alerts" });
    expect(f.confidence).toBe("confirmed");
    requireAllEvidence(f.evidence, "confirmed");
    expect(repo.rollup.label).toBe("coverage_gap");
  });

  test("rate-limit 403 becomes ScanError", async () => {
    const report = await scanReport("alerts_rate_limited", "--repo", "acme/limited");

    expect(report.repositories).toEqual([]);
    expect(report.scan_errors).toHaveLength(1);
    const e = report.scan_errors[0]!;
    expect(e.repository).toBe("acme/limited");
    expect(e.stage).toBe("alerts_open");
    expect(e.message).not.toBe("");
  });

  test("acknowledges merge awaiting re-evaluation within grace window", async () => {
    const report = await scanReport("merged_within_grace", "--repo", "acme/justmerged");
    const repo = singleRepo(report);

    const u = singleUpdate(repo);
    expect(u.state).not.toBe("merged_not_effective");
    expect(u.state).toBe("pending");
    expect(u.detail).toContain("#95");
    expect(u.detail).toContain("merged");
    expect(u.evidence.some((e) => e.description.includes("merged"))).toBe(true);
    for (const e of u.evidence) {
      expect(e.description).not.toContain("no open Dependabot pull request");
    }
  });

  test("table output projects the report without STATE header", async () => {
    const { stdout, stderr, code } = await runScan("healthy_empty", ["--repo", "acme/empty"]);
    expect(code, `stderr: ${stderr}`).toBe(0);
    expect(stderr).toBe("");
    for (const want of ["REPOSITORY", "ROLLUP", "acme/empty", "healthy"]) {
      expect(stdout).toContain(want);
    }
    expect(stdout).not.toContain("STATE");
  });

  test("table output includes judgments and evidence", async () => {
    const { stdout, stderr, code } = await runScan("update_open", ["--repo", "acme/rolling"]);
    expect(code, `stderr: ${stderr}`).toBe(0);
    expect(stderr).toBe("");
    for (const want of [
      "JUDGMENTS",
      "EVIDENCE",
      "expected_update",
      "update_open",
      "package.json:axios",
      "confirmed",
      "3d",
      "parse",
      "2026-08-01T12:00:00Z",
      "GET /repos/acme/rolling/pulls?state=open",
      "open for 3 days",
    ]) {
      expect(stdout).toContain(want);
    }
  });

  test("known-healthy repositories do not stall", async () => {
    const cases = [
      { name: "recorded repository", cassette: "recorded_necofuryai_dev", target: "necofuryai/necofuryai.dev" },
      { name: "cooldown boundary", cassette: "cooldown_healthy", target: "acme/cooldown" },
      { name: "covered manifest", cassette: "covered_manifest", target: "acme/covered" },
    ];
    for (const tc of cases) {
      const report = await scanReport(tc.cassette, "--repo", tc.target);
      const repo = singleRepo(report);
      for (const f of repo.findings) {
        expect(f.type, `false stall on ${tc.target}`).not.toBe("paused_or_stalled");
        requireAllEvidence(f.evidence);
      }
      for (const u of repo.expected_updates) {
        requireAllEvidence(u.evidence);
      }
    }
  });

  test("healthy empty repository matches JSON contract", async () => {
    const report = await scanReport("healthy_empty", "--repo", "acme/empty");

    expect(report.observed_at).toBe("2026-08-01T12:00:00Z");
    expect(report.target).toEqual({ repos: ["acme/empty"] });
    const repo = singleRepo(report);
    expect(repo.repository).toBe("acme/empty");
    expect(repo.default_branch).toBe("main");
    expect(repo.rollup).toEqual({ label: "healthy", counts: {} });
    expect(repo.findings).toEqual([]);
    expect(repo.expected_updates).toEqual([]);
  });
});

describe("CLI contract, exit codes, and target deduplication", () => {
  test("usage errors exit 2 with Error: prefix on stderr", async () => {
    const cases = [
      {
        name: "missing --repo and --org",
        args: ["scan"],
        env: { GITHUB_TOKEN: "test-token" },
        stderr: "Error: at least one --repo owner/name or an --org is required\n",
      },
      {
        name: "unknown --output format",
        args: ["scan", "--repo", "acme/empty", "--output", "xml"],
        env: { GITHUB_TOKEN: "test-token" },
        stderr: 'Error: unknown output format "xml" (json|table)\n',
      },
      {
        name: "missing GITHUB_TOKEN and GH_TOKEN",
        args: ["scan", "--repo", "acme/empty"],
        env: {},
        stderr: "Error: GITHUB_TOKEN (or GH_TOKEN) is not set; depatrol needs a read-only token\n",
      },
      {
        name: "unknown scan flag",
        args: ["scan", "--bogus"],
        env: { GITHUB_TOKEN: "test-token" },
        stderr: "Error: unknown flag: --bogus\n",
      },
      {
        name: "missing flag value",
        args: ["scan", "--repo"],
        env: { GITHUB_TOKEN: "test-token" },
        stderr: "Error: flag needs an argument: --repo\n",
      },
      {
        name: "unknown root command",
        args: ["bogus"],
        env: {},
        stderr: 'Error: unknown command "bogus" for "depatrol"\n',
      },
      {
        name: "unknown root flag",
        args: ["--bogus"],
        env: {},
        stderr: "Error: unknown flag: --bogus\n",
      },
    ];

    for (const tc of cases) {
      const stdout = createBuffer();
      const stderr = createBuffer();
      const code = await run(tc.args, { stdout, stderr, env: tc.env });
      expect(code, tc.name).toBe(2);
      expect(stdout.text(), tc.name).toBe("");
      expect(stderr.text(), tc.name).toBe(tc.stderr);
    }
  });

  test("GH_TOKEN fallback works when GITHUB_TOKEN is unset or empty", async () => {
    const { stdout, stderr, code } = await runScan(
      "healthy_empty",
      ["--repo", "acme/empty", "--output", "json"],
      { GITHUB_TOKEN: "", GH_TOKEN: "fallback-token" },
    );
    expect(code, stderr).toBe(0);
    const report = JSON.parse(stdout) as ReportJSON;
    expect(singleRepo(report).repository).toBe("acme/empty");
  });

  test("operational failure while listing organization repositories exits 1", async () => {
    const stdout = createBuffer();
    const stderr = createBuffer();
    const failingFetch = async () =>
      new Response(JSON.stringify({ message: "Not Found" }), {
        status: 404,
        statusText: "Not Found",
        headers: { "Content-Type": "application/json" },
      });

    const code = await run(["scan", "--org", "missing-org"], {
      fetch: failingFetch,
      now: () => FIXED_NOW,
      stdout,
      stderr,
      env: { GITHUB_TOKEN: "test-token" },
      paceRatePerSec: 0,
    });
    expect(code).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("Error: listing repositories of missing-org:");
  });

  test("malformed --repo produces stage=target ScanError and exits 0 in JSON and table modes", async () => {
    const unusedFetch = async () => {
      throw new Error("network should not be called for malformed target");
    };

    const jsonOut = createBuffer();
    const jsonErr = createBuffer();
    const jsonCode = await run(["scan", "--repo", "not-a-repo", "--output", "json"], {
      fetch: unusedFetch,
      now: () => FIXED_NOW,
      stdout: jsonOut,
      stderr: jsonErr,
      env: { GITHUB_TOKEN: "test-token" },
    });
    expect(jsonCode).toBe(0);
    expect(jsonErr.text()).toBe("");
    expect(jsonOut.text()).toBe(
      `{
  "observed_at": "2026-08-01T12:00:00Z",
  "target": {
    "repos": [
      "not-a-repo"
    ]
  },
  "repositories": [],
  "scan_errors": [
    {
      "repository": "not-a-repo",
      "stage": "target",
      "message": "target must be owner/name"
    }
  ]
}
`,
    );

    const tableOut = createBuffer();
    const tableErr = createBuffer();
    const tableCode = await run(["scan", "--repo", "not-a-repo"], {
      fetch: unusedFetch,
      now: () => FIXED_NOW,
      stdout: tableOut,
      stderr: tableErr,
      env: { GITHUB_TOKEN: "test-token" },
    });
    expect(tableCode).toBe(0);
    expect(tableErr.text()).toBe("");
    expect(tableOut.text()).toBe(
      "REPOSITORY  ROLLUP  CONDITIONS\n\nSCAN ERRORS\nnot-a-repo  target  target must be owner/name\n",
    );
  });

  test("deduplicateTargets preserves first-seen order", () => {
    expect(deduplicateTargets(["acme/a", "acme/b", "acme/a", "acme/c", "acme/b"])).toEqual([
      "acme/a",
      "acme/b",
      "acme/c",
    ]);
    expect(deduplicateTargets([])).toEqual([]);
  });

  test("CLI deduplicates repeated --repo flags without issuing duplicate HTTP requests", async () => {
    // healthy_empty has only one set of interactions for acme/empty;
    // scanning twice would fail replay-only mode immediately.
    const { stdout, stderr, code } = await runScan("healthy_empty", [
      "--repo",
      "acme/empty",
      "--repo=acme/empty",
      "--output",
      "json",
    ]);
    expect(code, stderr).toBe(0);
    const report = JSON.parse(stdout) as ReportJSON;
    expect(report.repositories.map((r) => r.repository)).toEqual(["acme/empty"]);
    expect(report.scan_errors).toEqual([]);
  });

  test("CLI deduplicates --org expansion overlap with --repo while preserving org-first order", async () => {
    // org_scan expands acme -> [acme/empty, acme/empty2] and holds exactly one
    // interaction set per repo; overlapping --repo acme/empty must not re-scan.
    const { stdout, stderr, code } = await runScan("org_scan", [
      "--org",
      "acme",
      "--repo",
      "acme/empty",
      "--output",
      "json",
    ]);
    expect(code, stderr).toBe(0);
    const report = JSON.parse(stdout) as ReportJSON;
    expect(report.repositories.map((r) => r.repository)).toEqual(["acme/empty", "acme/empty2"]);
    expect(report.target).toEqual({ org: "acme", repos: ["acme/empty"] });
    expect(report.scan_errors).toEqual([]);
  });

  test("help invocations exit 0 and print usage to stdout", async () => {
    for (const args of [[], ["--help"], ["-h"], ["help"], ["help", "scan"], ["scan", "--help"], ["scan", "-h"]]) {
      const stdout = createBuffer();
      const stderr = createBuffer();
      const code = await run(args, { stdout, stderr });
      expect(code, `args=${JSON.stringify(args)}`).toBe(0);
      expect(stdout.text()).toContain("Usage:");
      expect(stderr.text()).toBe("");
    }
  });
});

describe("table rendering and tabwriter parity", () => {
  test("renders pr_age_days=0 as 0d and resets column widths independently per section", () => {
    const report: Report = {
      observed_at: "2026-08-01T12:00:00Z",
      target: { repos: ["acme/a"] },
      repositories: [
        {
          repository: "acme/a",
          default_branch: "main",
          rollup: { label: "update_open", counts: { update_open: 1, coverage_gap: 1 } },
          findings: [
            {
              type: FindingType.CoverageGap,
              subject: { kind: SubjectKind.Manifest, id: "package.json" },
              confidence: Confidence.Confirmed,
              detail: "manifest not covered",
              evidence: [
                {
                  source: "GET /repos/acme/a/git/trees/main?recursive=1",
                  method: EvidenceMethod.APIRead,
                  description: "package.json found",
                  confidence: Confidence.Confirmed,
                  observed_at: "2026-08-01T12:00:00.000Z",
                },
              ],
            },
          ],
          expected_updates: [
            {
              manifest: "package.json",
              dependency: "lodash",
              state: LifecycleState.UpdateOpen,
              pr_age_days: 0,
              detail: "opened today",
              confidence: Confidence.Confirmed,
              evidence: [
                {
                  source: "GET /repos/acme/a/pulls?state=open",
                  method: EvidenceMethod.Parse,
                  description: "PR #1 opened today",
                  confidence: Confidence.Confirmed,
                  observed_at: "2026-08-01T12:00:00Z",
                },
              ],
            },
          ],
        },
      ],
      scan_errors: [
        {
          repository: "acme/very-long-repository-name-only-in-errors",
          stage: "repository",
          message: "500 error",
        },
      ],
    };

    const table = renderTable(report);
    const lines = table.split("\n");

    // Trailing newline, no trailing whitespace on any line.
    expect(table.endsWith("\n")).toBe(true);
    for (const line of lines) {
      expect(line).not.toMatch(/[ \t]+$/);
    }

    // Summary section widths must NOT be widened by SCAN ERRORS long repo name.
    expect(lines[0]).toBe("REPOSITORY  ROLLUP       CONDITIONS");
    expect(lines[1]).toBe("acme/a      update_open  coverage_gap:1 update_open:1");

    // pr_age_days=0 renders as "0d", never "-".
    const updateRow = lines.find((l) => l.includes("expected_update") && l.includes("opened today"));
    expect(updateRow).toBeDefined();
    expect(updateRow).toContain("  0d      opened today");

    // OBSERVED AT strips fractional .000 to match Go time.RFC3339.
    expect(table).toContain("2026-08-01T12:00:00Z");
    expect(table).not.toContain(".000Z");
  });

  test("formatTabWriter measures cell width by Unicode code points", () => {
    const out = formatTabWriter("A\tB\n日本語\tC\n");
    // "日本語" is 3 runes -> width 3 + 2 = 5 -> "A" padded with 4 spaces, "日本語" padded with 2 spaces.
    expect(out).toBe("A    B\n日本語  C\n");
  });
});
