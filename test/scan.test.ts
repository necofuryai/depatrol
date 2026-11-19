import { describe, expect, test } from "bun:test";
import { Confidence, FindingType, LifecycleState, SubjectKind } from "../src/domain/domain.ts";
import { parseBotConfig } from "../src/scan/botconfig.ts";
import {
  GitHubAPIError,
  GitHubRateLimitError,
  GitHubSecondaryRateLimitError,
  createGitHubClient,
  decodeBase64UTF8,
  parseNextLink,
  parseRetryAfterMs,
  type FetchLike,
} from "../src/scan/github.ts";
import {
  Scanner,
  createGitHubClient as createPublicGitHubClient,
} from "../src/scan/index.ts";
import {
  anyEntryCovers,
  cleanPosixPath,
  detectManifests,
  directoryOf,
  manifestDirectory,
} from "../src/scan/manifests.ts";
import { entryWindowDays } from "../src/scan/scan.ts";
import { parseBumpTitle, prAgeDays } from "../src/scan/updates.ts";

const FIXED_NOW = new Date("2026-08-01T12:00:00Z");

function jsonResponse(
  body: unknown,
  init: { status?: number; statusText?: string; headers?: Record<string, string> } = {},
): Response {
  const status = init.status ?? 200;
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json; charset=utf-8");
  }
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    statusText: init.statusText ?? (status === 200 ? "OK" : "Error"),
    headers,
  });
}

function encodeBase64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

interface RecordedRequest {
  url: string;
  method: string;
  headers: Headers;
}

function createMockRouter(
  handlers: Record<string, (req: RecordedRequest) => Response | Promise<Response>>,
): { fetch: FetchLike; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const req: RecordedRequest = { url, method, headers };
    requests.push(req);
    const handler = handlers[url];
    if (!handler) {
      throw new Error(`unexpected request: ${method} ${url}`);
    }
    return handler(req);
  };
  return { fetch, requests };
}

function defaultRepoRoutes(
  owner: string,
  name: string,
  overrides: Partial<Record<string, () => Response>> = {},
): Record<string, (req: RecordedRequest) => Response> {
  const base = `https://api.github.com/repos/${owner}/${name}`;
  const defaults: Record<string, () => Response> = {
    [base]: () =>
      jsonResponse({
        full_name: `${owner}/${name}`,
        default_branch: "main",
        archived: false,
      }),
    [`${base}/git/trees/main?recursive=1`]: () =>
      jsonResponse({
        sha: "abc123",
        tree: [
          { path: "package.json", type: "blob" },
          { path: ".github/dependabot.yml", type: "blob" },
        ],
        truncated: false,
      }),
    [`${base}/contents/.github/dependabot.yml?ref=main`]: () =>
      jsonResponse({
        type: "file",
        encoding: "base64",
        content: encodeBase64(
          'version: 2\nupdates:\n  - package-ecosystem: "npm"\n    directory: "/"\n    schedule:\n      interval: "weekly"\n',
        ),
      }),
    [`${base}/automated-security-fixes`]: () => jsonResponse({ enabled: true, paused: false }),
    [`${base}/dependabot/alerts?per_page=100&state=open`]: () => jsonResponse([]),
    [`${base}/dependabot/alerts?per_page=100&state=fixed`]: () => jsonResponse([]),
    [`${base}/commits?author=dependabot%5Bbot%5D&per_page=1`]: () =>
      jsonResponse([
        { commit: { committer: { date: "2026-07-30T12:00:00Z" } } },
      ]),
    [`${base}/pulls?per_page=100&state=open`]: () => jsonResponse([]),
    [`${base}/pulls?per_page=100&state=closed`]: () => jsonResponse([]),
  };

  const merged: Record<string, (req: RecordedRequest) => Response> = {};
  for (const [url, fn] of Object.entries(defaults)) {
    merged[url] = () => fn();
  }
  for (const [url, fn] of Object.entries(overrides)) {
    if (fn) {
      merged[url] = () => fn();
    }
  }
  return merged;
}

describe("manifests detection and directory coverage", () => {
  test("detects all 12 manifest filenames plus github-actions workflows", () => {
    const paths = [
      "package.json",
      "services/api/go.mod",
      "ml/requirements.txt",
      "py/pyproject.toml",
      "legacy/Pipfile",
      "ruby/Gemfile",
      "rust/Cargo.toml",
      "php/composer.json",
      "java/pom.xml",
      "android/build.gradle",
      "kotlin/build.gradle.kts",
      "docker/Dockerfile",
      ".github/workflows/ci.yml",
      ".github/workflows/release.yaml",
      // Non-manifests (including Object.prototype property names)
      "README.md",
      "toString",
      "constructor",
      ".github/dependabot.yml",
      ".github/workflows/README.md",
    ];

    const detected = detectManifests(paths);
    expect(detected).toEqual([
      { path: "package.json", ecosystem: "npm" },
      { path: "services/api/go.mod", ecosystem: "gomod" },
      { path: "ml/requirements.txt", ecosystem: "pip" },
      { path: "py/pyproject.toml", ecosystem: "pip" },
      { path: "legacy/Pipfile", ecosystem: "pip" },
      { path: "ruby/Gemfile", ecosystem: "bundler" },
      { path: "rust/Cargo.toml", ecosystem: "cargo" },
      { path: "php/composer.json", ecosystem: "composer" },
      { path: "java/pom.xml", ecosystem: "maven" },
      { path: "android/build.gradle", ecosystem: "gradle" },
      { path: "kotlin/build.gradle.kts", ecosystem: "gradle" },
      { path: "docker/Dockerfile", ecosystem: "docker" },
      { path: ".github/workflows/ci.yml", ecosystem: "github-actions" },
      { path: ".github/workflows/release.yaml", ecosystem: "github-actions" },
    ]);
  });

  test("directoryOf, cleanPosixPath, manifestDirectory, and entryCovers match Go semantics", () => {
    expect(directoryOf("package.json")).toBe("/");
    expect(directoryOf("apps/web/package.json")).toBe("/apps/web");
    expect(cleanPosixPath("/")).toBe("/");
    expect(cleanPosixPath("/app/")).toBe("/app");
    expect(cleanPosixPath("/app//sub/")).toBe("/app/sub");
    expect(cleanPosixPath("")).toBe(".");

    expect(
      manifestDirectory({ path: ".github/workflows/ci.yml", ecosystem: "github-actions" }),
    ).toBe("/");
    expect(manifestDirectory({ path: "apps/web/package.json", ecosystem: "npm" })).toBe("/apps/web");

    const cfg = parseBotConfig(`
version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/apps/web/"
    schedule:
      interval: "weekly"
  - package-ecosystem: "gomod"
    directories:
      - "/"
      - "/tools/"
    schedule:
      interval: "daily"
  - package-ecosystem: "github-actions"
    directory: "/"
    schedule:
      interval: "monthly"
`);
    expect(anyEntryCovers(cfg.updates, { path: "apps/web/package.json", ecosystem: "npm" })).toBe(
      true,
    );
    expect(anyEntryCovers(cfg.updates, { path: "package.json", ecosystem: "npm" })).toBe(false);
    expect(anyEntryCovers(cfg.updates, { path: "tools/go.mod", ecosystem: "gomod" })).toBe(true);
    expect(anyEntryCovers(cfg.updates, { path: "go.mod", ecosystem: "gomod" })).toBe(true);
    expect(
      anyEntryCovers(cfg.updates, {
        path: ".github/workflows/ci.yml",
        ecosystem: "github-actions",
      }),
    ).toBe(true);
  });
});

describe("botconfig parsing and window calculation", () => {
  test("parses version, schedule, cooldown default-days, directory, and directories", () => {
    const cfg = parseBotConfig(`
version: 2
updates:
  - package-ecosystem: npm
    directory: "/"
    schedule:
      interval: weekly
    cooldown:
      default-days: 14
  - package-ecosystem: gomod
    directories:
      - "/cmd"
      - "/pkg"
    schedule:
      interval: daily
  - package-ecosystem: pip
    directory: "/ml"
    schedule:
      interval: quarterly
`);
    expect(cfg.version).toBe(2);
    expect(cfg.updates).toHaveLength(3);
    expect(entryWindowDays(cfg.updates[0]!)).toBe(28); // 2*7 + 14
    expect(entryWindowDays(cfg.updates[1]!)).toBe(2); // 2*1 + 0
    expect(entryWindowDays(cfg.updates[2]!)).toBe(62); // unknown -> 2*31 + 0
  });

  test("handles empty YAML and UTF-8 base64 content with newlines", () => {
    expect(parseBotConfig("# just a comment\n")).toEqual({ version: 0, updates: [] });
    const yamlText = "# 日本語コメント\nversion: 2\nupdates: []\n";
    const b64WithNewlines = encodeBase64(yamlText).replace(/(.{12})/g, "$1\n");
    expect(decodeBase64UTF8(b64WithNewlines)).toBe(yamlText);
  });
});

describe("PR parsing, age clamping, and CHANGES_REQUESTED determinism", () => {
  test("parses standard, prefixed, and directory-scoped bump titles; ignores grouped titles", () => {
    expect(
      parseBumpTitle({ title: "Bump lodash from 4.17.20 to 4.17.21" }),
    ).toMatchObject({
      dependency: "lodash",
      fromVersion: "4.17.20",
      toVersion: "4.17.21",
      directory: "/",
    });
    expect(
      parseBumpTitle({ title: "chore(deps): bump axios from 1.0.0 to 1.1.0 in /apps/web" }),
    ).toMatchObject({
      dependency: "axios",
      fromVersion: "1.0.0",
      toVersion: "1.1.0",
      directory: "/apps/web",
    });
    expect(
      parseBumpTitle({ title: "Bump the npm-dependencies group with 3 updates" }),
    ).toBeNull();
  });

  test("prAgeDays truncates toward zero and preserves explicit 0", () => {
    expect(prAgeDays(FIXED_NOW, { created_at: "2026-08-01T06:00:00Z" })).toBe(0);
    expect(prAgeDays(FIXED_NOW, { created_at: "2026-08-02T12:00:00Z" })).toBe(0); // future clamped to 0
    expect(prAgeDays(FIXED_NOW, { created_at: "2026-07-29T12:00:00Z" })).toBe(3);
  });

  test("CHANGES_REQUESTED selects reviewer deterministically by ascending codepoint login", async () => {
    const base = "https://api.github.com/repos/acme/revieworder";
    const runWithReviews = async (
      reviews: Array<{ id: number; state: string; user: { login: string }; submitted_at: string }>,
    ) => {
      const { fetch } = createMockRouter(
        defaultRepoRoutes("acme", "revieworder", {
          [`${base}/pulls?per_page=100&state=open`]: () =>
            jsonResponse([
              {
                number: 10,
                state: "open",
                title: "Bump axios from 1.0.0 to 1.1.0",
                user: { login: "dependabot[bot]" },
                created_at: "2026-08-01T10:00:00Z", // 0 days old -> verifies pr_age_days: 0
                head: { ref: "dependabot/npm_and_yarn/axios-1.1.0", sha: "sha10" },
              },
            ]),
          [`${base}/pulls/10`]: () =>
            jsonResponse({
              number: 10,
              mergeable: true,
              mergeable_state: "blocked",
            }),
          [`${base}/pulls/10/reviews?per_page=100`]: () => jsonResponse(reviews),
          [`${base}/commits/sha10/check-runs`]: () => jsonResponse({ total_count: 0, check_runs: [] }),
        }),
      );
      const client = createPublicGitHubClient({ token: "t", fetch, paceRatePerSec: 0 });
      const scanner = new Scanner(client, () => FIXED_NOW);
      return scanner.scanRepositories(["acme/revieworder"]);
    };

    const orderA = await runWithReviews([
      { id: 1, state: "CHANGES_REQUESTED", user: { login: "charlie" }, submitted_at: "2026-08-01T10:30:00Z" },
      { id: 2, state: "CHANGES_REQUESTED", user: { login: "bob" }, submitted_at: "2026-08-01T10:40:00Z" },
      { id: 3, state: "CHANGES_REQUESTED", user: { login: "alice" }, submitted_at: "2026-08-01T10:20:00Z" },
    ]);
    const orderB = await runWithReviews([
      { id: 3, state: "CHANGES_REQUESTED", user: { login: "alice" }, submitted_at: "2026-08-01T10:20:00Z" },
      { id: 1, state: "CHANGES_REQUESTED", user: { login: "charlie" }, submitted_at: "2026-08-01T10:30:00Z" },
      { id: 2, state: "CHANGES_REQUESTED", user: { login: "bob" }, submitted_at: "2026-08-01T10:40:00Z" },
    ]);

    const updateA = orderA.repositories[0]!.expected_updates[0]!;
    const updateB = orderB.repositories[0]!.expected_updates[0]!;
    expect(updateA).toEqual(updateB);
    expect(updateA.pr_age_days).toBe(0);
    expect(updateA.state).toBe(LifecycleState.Blocked);
    expect(updateA.blocked_reasons).toEqual(["changes_requested"]);
    expect(updateA.evidence[1]!.description).toBe("latest review by alice on PR #10 requests changes");

    // When alice later approves, bob (next in codepoint order) is deterministically selected
    const afterAliceApproved = await runWithReviews([
      { id: 1, state: "CHANGES_REQUESTED", user: { login: "charlie" }, submitted_at: "2026-08-01T10:30:00Z" },
      { id: 2, state: "CHANGES_REQUESTED", user: { login: "bob" }, submitted_at: "2026-08-01T10:40:00Z" },
      { id: 3, state: "CHANGES_REQUESTED", user: { login: "alice" }, submitted_at: "2026-08-01T10:20:00Z" },
      { id: 4, state: "APPROVED", user: { login: "alice" }, submitted_at: "2026-08-01T11:00:00Z" },
    ]);
    expect(afterAliceApproved.repositories[0]!.expected_updates[0]!.evidence[1]!.description).toBe(
      "latest review by bob on PR #10 requests changes",
    );
  });

  test("strict boundaries: review_pending > 7 days and merged_not_effective > 24h", async () => {
    const base = "https://api.github.com/repos/acme/bounds";
    const { fetch } = createMockRouter(
      defaultRepoRoutes("acme", "bounds", {
        [`${base}/dependabot/alerts?per_page=100&state=open`]: () =>
          jsonResponse([
            {
              number: 1,
              state: "open",
              dependency: { package: { ecosystem: "npm", name: "exact24h" }, manifest_path: "package.json" },
              security_advisory: { ghsa_id: "GHSA-0001" },
              security_vulnerability: { severity: "high", first_patched_version: { identifier: "2.0.0" } },
            },
            {
              number: 2,
              state: "open",
              dependency: { package: { ecosystem: "npm", name: "over24h" }, manifest_path: "package.json" },
              security_advisory: { ghsa_id: "GHSA-0002" },
              security_vulnerability: { severity: "high", first_patched_version: { identifier: "2.0.0" } },
            },
          ]),
        [`${base}/pulls?per_page=100&state=open`]: () =>
          jsonResponse([
            {
              number: 20,
              state: "open",
              title: "Bump wait7 from 1.0.0 to 1.1.0",
              user: { login: "dependabot[bot]" },
              created_at: "2026-07-25T12:00:00Z", // exactly 7 days -> NOT blocked
              head: { ref: "dependabot/npm_and_yarn/wait7-1.1.0", sha: "s20" },
            },
            {
              number: 21,
              state: "open",
              title: "Bump wait8 from 1.0.0 to 1.1.0",
              user: { login: "dependabot[bot]" },
              created_at: "2026-07-24T12:00:00Z", // 8 days -> review_pending (inferred)
              head: { ref: "dependabot/npm_and_yarn/wait8-1.1.0", sha: "s21" },
            },
          ]),
        [`${base}/pulls?per_page=100&state=closed`]: () =>
          jsonResponse([
            {
              number: 30,
              state: "closed",
              title: "Bump exact24h from 1.0.0 to 2.0.0",
              user: { login: "dependabot[bot]" },
              created_at: "2026-07-31T10:00:00Z",
              merged_at: "2026-07-31T12:00:00Z", // exactly 24h -> still pending
            },
            {
              number: 31,
              state: "closed",
              title: "Bump over24h from 1.0.0 to 2.0.0",
              user: { login: "dependabot[bot]" },
              created_at: "2026-07-31T10:00:00Z",
              merged_at: "2026-07-31T11:59:59Z", // 24h + 1s -> merged_not_effective
            },
          ]),
        [`${base}/pulls/20`]: () =>
          jsonResponse({ number: 20, mergeable: null, requested_reviewers: [{ login: "bob" }] }),
        [`${base}/pulls/20/reviews?per_page=100`]: () => jsonResponse([]),
        [`${base}/commits/s20/check-runs`]: () => jsonResponse({ check_runs: [] }),
        [`${base}/pulls/21`]: () =>
          jsonResponse({ number: 21, mergeable: true, requested_reviewers: [{ login: "bob" }] }),
        [`${base}/pulls/21/reviews?per_page=100`]: () => jsonResponse([]),
        [`${base}/commits/s21/check-runs`]: () => jsonResponse({ check_runs: [] }),
      }),
    );

    const client = createGitHubClient({ token: "t", fetch, paceRatePerSec: 0 });
    const report = await new Scanner(client, () => FIXED_NOW).scanRepositories(["acme/bounds"]);
    const updates = report.repositories[0]!.expected_updates;

    const exact24h = updates.find((u) => u.dependency === "exact24h")!;
    expect(exact24h.state).toBe(LifecycleState.Pending);
    expect(exact24h.detail).toContain("merged 24h ago");

    const over24h = updates.find((u) => u.dependency === "over24h")!;
    expect(over24h.state).toBe(LifecycleState.MergedNotEffective);

    const wait7 = updates.find((u) => u.dependency === "wait7")!;
    expect(wait7.state).toBe(LifecycleState.UpdateOpen);
    expect(wait7.blocked_reasons).toBeUndefined();

    const wait8 = updates.find((u) => u.dependency === "wait8")!;
    expect(wait8.state).toBe(LifecycleState.Blocked);
    expect(wait8.blocked_reasons).toEqual(["review_pending"]);
    expect(wait8.confidence).toBe(Confidence.Inferred);
  });
});

describe("GitHubClient HTTP contract, pagination, pacing, and rate limits", () => {
  test("parses RFC 8288 Link headers and Retry-After headers", () => {
    expect(
      parseNextLink(
        '<https://api.github.com/orgs/acme/repos?page=1>; rel="prev", <https://api.github.com/orgs/acme/repos?per_page=100&page=2>; rel="next", <https://api.github.com/orgs/acme/repos?page=4>; rel="last"',
      ),
    ).toBe("https://api.github.com/orgs/acme/repos?per_page=100&page=2");
    expect(parseNextLink('<https://api.github.com/x?page=2>; rel=next')).toBe(
      "https://api.github.com/x?page=2",
    );
    expect(parseNextLink('<https://api.github.com/x?page=1>; rel="prev"')).toBeNull();
    expect(parseNextLink(null)).toBeNull();

    expect(parseRetryAfterMs("5", 1000)).toBe(5000);
    expect(parseRetryAfterMs("0", 1000)).toBe(0);
    expect(parseRetryAfterMs("Sat, 01 Aug 2026 12:00:10 GMT", Date.parse("2026-08-01T12:00:00Z"))).toBe(
      10_000,
    );
    expect(parseRetryAfterMs(null, 1000)).toBeUndefined();
  });

  test("paginates org repos with sorted query params, sends go-github headers, and skips archived", async () => {
    const { fetch, requests } = createMockRouter({
      "https://api.github.com/orgs/acme/repos?per_page=100": () =>
        jsonResponse(
          [
            { full_name: "acme/active1", archived: false },
            { full_name: "acme/archived", archived: true },
          ],
          {
            headers: {
              Link: '<https://api.github.com/orgs/acme/repos?per_page=100&page=2>; rel="next"',
            },
          },
        ),
      "https://api.github.com/orgs/acme/repos?page=2&per_page=100": () =>
        jsonResponse([{ full_name: "acme/active2", archived: false }]),
    });

    const client = createGitHubClient({ token: "ghp_secret", fetch, paceRatePerSec: 0 });
    const scanner = new Scanner(client, () => FIXED_NOW);
    const repos = await scanner.listOrganizationRepositories("acme");

    expect(repos).toEqual(["acme/active1", "acme/active2"]);
    expect(requests.map((r) => r.url)).toEqual([
      "https://api.github.com/orgs/acme/repos?per_page=100",
      "https://api.github.com/orgs/acme/repos?page=2&per_page=100",
    ]);
    expect(requests[0]!.headers.get("authorization")).toBe("Bearer ghp_secret");
    expect(requests[0]!.headers.get("accept")).toBe("application/vnd.github.v3+json");
    expect(requests[0]!.headers.get("x-github-api-version")).toBe("2022-11-28");
  });

  test("rejects cross-origin pagination Link headers", async () => {
    const { fetch } = createMockRouter({
      "https://api.github.com/orgs/acme/repos?per_page=100": () =>
        jsonResponse([], {
          headers: {
            Link: '<https://evil.example/orgs/acme/repos?page=2>; rel="next"',
          },
        }),
    });
    const client = createGitHubClient({ token: "ghp_secret", fetch, paceRatePerSec: 0 });
    await expect(client.listOrgRepositories("acme")).rejects.toThrow("cross-origin");
  });

  test("paginates check-runs without per_page on page 1 and with ?page=2 on page 2", async () => {
    const { fetch, requests } = createMockRouter({
      "https://api.github.com/repos/acme/paged/commits/abc123/check-runs": () =>
        jsonResponse(
          { total_count: 2, check_runs: [{ id: 1, name: "lint", status: "completed", conclusion: "success" }] },
          {
            headers: {
              Link: '<https://api.github.com/repos/acme/paged/commits/abc123/check-runs?page=2>; rel="next"',
            },
          },
        ),
      "https://api.github.com/repos/acme/paged/commits/abc123/check-runs?page=2": () =>
        jsonResponse({
          total_count: 2,
          check_runs: [{ id: 2, name: "test", status: "completed", conclusion: "failure" }],
        }),
    });
    const client = createGitHubClient({ token: "t", fetch, paceRatePerSec: 0 });
    const runs = await client.listCheckRunsForRef("acme", "paged", "abc123");
    expect(runs).toHaveLength(2);
    expect(runs[1]!.conclusion).toBe("failure");
    expect(requests.map((r) => r.url)).toEqual([
      "https://api.github.com/repos/acme/paged/commits/abc123/check-runs",
      "https://api.github.com/repos/acme/paged/commits/abc123/check-runs?page=2",
    ]);
  });

  test("enforces 8 req/s token-bucket pacing with burst 8", async () => {
    const sleeps: number[] = [];
    let fakeNow = 1_000_000;
    const sleep = async (ms: number): Promise<void> => {
      sleeps.push(ms);
      fakeNow += ms;
    };
    const fetch: FetchLike = async () => jsonResponse({ default_branch: "main" });

    const client = createGitHubClient({
      token: "t",
      fetch,
      paceRatePerSec: 8,
      paceBurst: 8,
      sleep,
      nowMs: () => fakeNow,
    });

    for (let i = 0; i < 10; i++) {
      await client.getRepository("acme", "repo");
    }
    // First 8 consume the burst immediately; 9th and 10th each wait ceil(1000/8) = 125ms.
    expect(sleeps).toEqual([125, 125]);
  });

  test("retries secondary rate limits up to maxSecondaryRetryAfterMs and fails when exceeded", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const fetch: FetchLike = async () => {
      calls++;
      if (calls === 1) {
        return jsonResponse(
          { message: "You have exceeded a secondary rate limit." },
          { status: 403, headers: { "Retry-After": "5" } },
        );
      }
      return jsonResponse({ default_branch: "main" });
    };

    const client = createGitHubClient({
      token: "t",
      fetch,
      paceRatePerSec: 0,
      maxSecondaryRetryAfterMs: 60_000,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const repo = await client.getRepository("acme", "ok");
    expect(repo.default_branch).toBe("main");
    expect(calls).toBe(2);
    expect(sleeps).toEqual([5000]);

    // Retry-After > 60s must fail immediately without sleeping
    const longSleeps: number[] = [];
    const fetchTooLong: FetchLike = async () =>
      jsonResponse(
        { message: "You have exceeded a secondary rate limit." },
        { status: 429, headers: { "Retry-After": "61" } },
      );
    const clientTooLong = createGitHubClient({
      token: "t",
      fetch: fetchTooLong,
      paceRatePerSec: 0,
      maxSecondaryRetryAfterMs: 60_000,
      sleep: async (ms) => {
        longSleeps.push(ms);
      },
    });
    await expect(clientTooLong.getRepository("acme", "slow")).rejects.toBeInstanceOf(
      GitHubSecondaryRateLimitError,
    );
    expect(longSleeps).toEqual([]);
  });

  test("rejects truncated Git tree with stage='tree' ScanError", async () => {
    const base = "https://api.github.com/repos/acme/huge";
    const { fetch } = createMockRouter({
      [base]: () => jsonResponse({ full_name: "acme/huge", default_branch: "main" }),
      [`${base}/git/trees/main?recursive=1`]: () =>
        jsonResponse({
          sha: "deadbeef",
          tree: [{ path: "package.json", type: "blob" }],
          truncated: true,
        }),
    });

    const client = createGitHubClient({ token: "t", fetch, paceRatePerSec: 0 });
    const report = await new Scanner(client, () => FIXED_NOW).scanRepositories(["acme/huge"]);
    expect(report.repositories).toEqual([]);
    expect(report.scan_errors).toEqual([
      {
        repository: "acme/huge",
        stage: "tree",
        message:
          "recursive Git tree response was truncated; manifest coverage cannot be judged safely",
      },
    ]);
  });

  test("separates alerts 403 disabled (coverage_gap) vs rate-limit 403 vs permission 403 (ScanError)", async () => {
    // Case 1: Alerts disabled -> coverage_gap finding, alerts?state=fixed NOT called
    const disabledBase = "https://api.github.com/repos/acme/noalerts";
    const disabledRoutes = defaultRepoRoutes("acme", "noalerts", {
      [`${disabledBase}/dependabot/alerts?per_page=100&state=open`]: () =>
        jsonResponse(
          { message: "Dependabot alerts are disabled for this repository." },
          { status: 403 },
        ),
    });
    delete disabledRoutes[`${disabledBase}/dependabot/alerts?per_page=100&state=fixed`];
    const disabledRouter = createMockRouter(disabledRoutes);
    const disabledReport = await new Scanner(
      createGitHubClient({ token: "t", fetch: disabledRouter.fetch, paceRatePerSec: 0 }),
      () => FIXED_NOW,
    ).scanRepositories(["acme/noalerts"]);

    expect(disabledReport.scan_errors).toEqual([]);
    expect(disabledReport.repositories).toHaveLength(1);
    const gap = disabledReport.repositories[0]!.findings[0]!;
    expect(gap.type).toBe(FindingType.CoverageGap);
    expect(gap.subject).toEqual({ kind: SubjectKind.BotConfig, id: "dependabot-alerts" });
    expect(gap.confidence).toBe(Confidence.Confirmed);

    // Case 2: Primary rate limit 403 -> ScanError at alerts_open (even if body mentions disabled)
    const limitedBase = "https://api.github.com/repos/acme/limited";
    const limitedRouter = createMockRouter(
      defaultRepoRoutes("acme", "limited", {
        [`${limitedBase}/dependabot/alerts?per_page=100&state=open`]: () =>
          jsonResponse(
            { message: "API rate limit exceeded for installation ID 1." },
            {
              status: 403,
              headers: {
                "X-Ratelimit-Limit": "5000",
                "X-Ratelimit-Remaining": "0",
                "X-Ratelimit-Reset": "1785562000",
              },
            },
          ),
      }),
    );
    const limitedClient = createGitHubClient({
      token: "t",
      fetch: limitedRouter.fetch,
      paceRatePerSec: 0,
    });
    await expect(
      limitedClient.listRepoAlerts("acme", "limited", "open"),
    ).rejects.toBeInstanceOf(GitHubRateLimitError);

    const limitedReport = await new Scanner(limitedClient, () => FIXED_NOW).scanRepositories([
      "acme/limited",
    ]);
    expect(limitedReport.repositories).toEqual([]);
    expect(limitedReport.scan_errors).toHaveLength(1);
    expect(limitedReport.scan_errors[0]!.stage).toBe("alerts_open");

    // Case 3: Missing permission 403 (no "disabled" in message) -> ScanError at alerts_open
    const permBase = "https://api.github.com/repos/acme/noscope";
    const permRouter = createMockRouter(
      defaultRepoRoutes("acme", "noscope", {
        [`${permBase}/dependabot/alerts?per_page=100&state=open`]: () =>
          jsonResponse({ message: "Resource not accessible by integration" }, { status: 403 }),
      }),
    );
    const permClient = createGitHubClient({
      token: "t",
      fetch: permRouter.fetch,
      paceRatePerSec: 0,
    });
    await expect(permClient.listRepoAlerts("acme", "noscope", "open")).rejects.toBeInstanceOf(
      GitHubAPIError,
    );
    const permReport = await new Scanner(permClient, () => FIXED_NOW).scanRepositories([
      "acme/noscope",
    ]);
    expect(permReport.repositories).toEqual([]);
    expect(permReport.scan_errors).toHaveLength(1);
    expect(permReport.scan_errors[0]!.stage).toBe("alerts_open");
  });

  test("continues scanning independent repositories when earlier targets fail", async () => {
    const goodRoutes = defaultRepoRoutes("acme", "good", {
      "https://api.github.com/repos/acme/good/commits?author=dependabot%5Bbot%5D&per_page=1": () =>
        jsonResponse({ message: "Git Repository is empty." }, { status: 409 }),
      "https://api.github.com/repos/acme/good/git/trees/main?recursive=1": () =>
        jsonResponse({ sha: "000", tree: [], truncated: false }),
      "https://api.github.com/repos/acme/good/contents/.github/dependabot.yml?ref=main": () =>
        jsonResponse({ message: "Not Found" }, { status: 404 }),
    });
    const { fetch } = createMockRouter({
      "https://api.github.com/repos/acme/broken": () =>
        jsonResponse({ message: "Internal Server Error" }, { status: 500 }),
      ...goodRoutes,
    });

    const client = createGitHubClient({ token: "t", fetch, paceRatePerSec: 0 });
    const report = await new Scanner(client, () => FIXED_NOW).scanRepositories([
      "not-a-repo",
      "acme/broken",
      "acme/good",
    ]);

    expect(report.repositories).toHaveLength(1);
    expect(report.repositories[0]!.repository).toBe("acme/good");
    expect(report.repositories[0]!.rollup.label).toBe("healthy");
    expect(report.scan_errors).toHaveLength(2);
    expect(report.scan_errors[0]).toEqual({
      repository: "not-a-repo",
      stage: "target",
      message: "target must be owner/name",
    });
    expect(report.scan_errors[1]!.repository).toBe("acme/broken");
    expect(report.scan_errors[1]!.stage).toBe("repository");
  });

  test("handles non-JSON 5xx error responses cleanly and accepts globalThis.fetch as FetchLike", async () => {
    const _typeCheck: FetchLike = globalThis.fetch;
    expect(typeof _typeCheck).toBe("function");

    const fetch: FetchLike = async () =>
      new Response("<html>502 Bad Gateway</html>", {
        status: 502,
        statusText: "Bad Gateway",
        headers: { "content-type": "text/html" },
      });
    const client = createGitHubClient({ token: "t", fetch, paceRatePerSec: 0 });
    await expect(client.getRepository("acme", "down")).rejects.toThrow("502");
  });
});

describe("Scanner judgment edge cases (coverage, stall, multi-advisory, effective)", () => {
  test("reports coverage_gap when dependabot.yml exists without covering entry, and handles 404 security-fixes on stall", async () => {
    const base = "https://api.github.com/repos/acme/partial";
    const { fetch } = createMockRouter(
      defaultRepoRoutes("acme", "partial", {
        [`${base}/git/trees/main?recursive=1`]: () =>
          jsonResponse({
            sha: "111",
            tree: [
              { path: "package.json", type: "blob" },
              { path: "services/api/go.mod", type: "blob" },
              { path: ".github/dependabot.yml", type: "blob" },
            ],
            truncated: false,
          }),
        [`${base}/automated-security-fixes`]: () =>
          jsonResponse({ message: "Not Found" }, { status: 404 }),
        [`${base}/commits?author=dependabot%5Bbot%5D&per_page=1`]: () => jsonResponse([]),
      }),
    );

    const report = await new Scanner(
      createGitHubClient({ token: "t", fetch, paceRatePerSec: 0 }),
      () => FIXED_NOW,
    ).scanRepositories(["acme/partial"]);

    const repo = report.repositories[0]!;
    const gap = repo.findings.find((f) => f.type === FindingType.CoverageGap)!;
    expect(gap.subject).toEqual({ kind: SubjectKind.Manifest, id: "services/api/go.mod" });
    expect(gap.evidence[1]!.description).toBe(
      ".github/dependabot.yml has no gomod entry whose directory covers /services/api",
    );

    const stalled = repo.findings.find((f) => f.type === FindingType.PausedOrStalled)!;
    expect(stalled.confidence).toBe(Confidence.Inferred);
    expect(stalled.evidence[1]!.description).toBe(
      "the automated-security-fixes state could not be observed (endpoint answered 404)",
    );
  });

  test("stall check uses newest of PRs and bot commits, with strict gapDays > window boundary", async () => {
    const runWithCommitDate = async (commitDate: string) => {
      const base = "https://api.github.com/repos/acme/stallbound";
      const { fetch } = createMockRouter(
        defaultRepoRoutes("acme", "stallbound", {
          [`${base}/commits?author=dependabot%5Bbot%5D&per_page=1`]: () =>
            jsonResponse([{ commit: { committer: { date: commitDate } } }]),
        }),
      );
      return new Scanner(
        createGitHubClient({ token: "t", fetch, paceRatePerSec: 0 }),
        () => FIXED_NOW,
      ).scanRepositories(["acme/stallbound"]);
    };

    // weekly schedule -> window = 14 days. Exactly 14 days ago -> healthy.
    const exact14 = await runWithCommitDate("2026-07-18T12:00:00Z");
    expect(exact14.repositories[0]!.rollup.label).toBe("healthy");

    // 15 days ago -> stalled (inferred) mentioning commit date and (15 days ago).
    const over14 = await runWithCommitDate("2026-07-17T12:00:00Z");
    const stalled = over14.repositories[0]!.findings[0]!;
    expect(stalled.type).toBe(FindingType.PausedOrStalled);
    expect(stalled.confidence).toBe(Confidence.Inferred);
    expect(stalled.evidence[2]!.description).toBe(
      "newest default-branch commit authored by the bot is from 2026-07-17T12:00:00Z (15 days ago)",
    );
  });

  test("collapses multiple open alerts on same (manifest, dependency), deduplicates open PR, and handles timed_out + merge_conflict", async () => {
    const base = "https://api.github.com/repos/acme/multi";
    const { fetch } = createMockRouter(
      defaultRepoRoutes("acme", "multi", {
        [`${base}/dependabot/alerts?per_page=100&state=open`]: () =>
          jsonResponse([
            {
              number: 1,
              state: "open",
              dependency: { package: { ecosystem: "npm", name: "lodash" }, manifest_path: "package.json" },
              security_advisory: { ghsa_id: "GHSA-1111" },
              security_vulnerability: { severity: "high", first_patched_version: null },
            },
            {
              number: 2,
              state: "open",
              dependency: { package: { ecosystem: "npm", name: "lodash" }, manifest_path: "package.json" },
              security_advisory: { ghsa_id: "GHSA-2222" },
              security_vulnerability: { severity: "critical", first_patched_version: { identifier: "4.17.21" } },
            },
          ]),
        [`${base}/dependabot/alerts?per_page=100&state=fixed`]: () =>
          jsonResponse([
            // Same identity still open -> must NOT emit effective
            {
              number: 3,
              state: "fixed",
              dependency: { package: { ecosystem: "npm", name: "lodash" }, manifest_path: "package.json" },
              security_advisory: { ghsa_id: "GHSA-0000" },
              fixed_at: "2026-07-20T00:00:00Z",
            },
            // Fixed without merged bot PR -> must NOT emit effective
            {
              number: 4,
              state: "fixed",
              dependency: { package: { ecosystem: "npm", name: "manual-pkg" }, manifest_path: "package.json" },
              security_advisory: { ghsa_id: "GHSA-9999" },
              fixed_at: "2026-07-20T00:00:00Z",
            },
          ]),
        [`${base}/pulls?per_page=100&state=open`]: () =>
          jsonResponse([
            {
              number: 55,
              state: "open",
              title: "Bump lodash from 4.17.20 to 4.17.21",
              user: { login: "dependabot[bot]" },
              created_at: "2026-07-30T12:00:00Z",
              head: { ref: "dependabot/npm_and_yarn/lodash-4.17.21", sha: "sha55" },
            },
          ]),
        [`${base}/pulls?per_page=100&state=closed`]: () =>
          jsonResponse([
            {
              number: 40,
              state: "closed",
              title: "Bump lodash from 4.17.19 to 4.17.20",
              user: { login: "dependabot[bot]" },
              created_at: "2026-07-18T00:00:00Z",
              merged_at: "2026-07-19T00:00:00Z",
            },
          ]),
        [`${base}/pulls/55`]: () =>
          jsonResponse({ number: 55, mergeable: false, mergeable_state: "dirty" }),
        [`${base}/pulls/55/reviews?per_page=100`]: () => jsonResponse([]),
        [`${base}/commits/sha55/check-runs`]: () =>
          jsonResponse({
            check_runs: [{ id: 1, name: "e2e", status: "completed", conclusion: "timed_out" }],
          }),
      }),
    );

    const report = await new Scanner(
      createGitHubClient({ token: "t", fetch, paceRatePerSec: 0 }),
      () => FIXED_NOW,
    ).scanRepositories(["acme/multi"]);

    const repo = report.repositories[0]!;
    // PR #55 consumed by advisory update (not double-counted as version update); neither fixed alert emits effective
    expect(repo.expected_updates).toHaveLength(1);
    const u = repo.expected_updates[0]!;
    expect(u.advisory_ids).toEqual(["GHSA-1111", "GHSA-2222"]);
    expect(u.state).toBe(LifecycleState.Blocked);
    expect(u.blocked_reasons).toEqual(["ci_failing", "merge_conflict"]);
    expect(u.detail).toBe(
      "Dependabot PR #55 for the security update is stopped after 2 days: ci_failing, merge_conflict",
    );

    const vuln = repo.findings.find((f) => f.type === FindingType.VulnerableUnpatched)!;
    expect(vuln.derived).toBe(true);
    expect(vuln.detail).toBe("unfixed vulnerability remains on the default branch: GHSA-1111, GHSA-2222");
  });
});
