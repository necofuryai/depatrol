/**
 * Thin GitHub REST API v3 client built solely on standard Web `fetch`.
 * Preserves go-github/v89 URL paths, alphabetically sorted query parameters,
 * Link-header pagination, token-bucket pacing, and bounded secondary rate-limit
 * retry without any Bun-specific APIs (Node 22+ / Bun compatible).
 */

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface GitHubClientOptions {
  token: string;
  fetch?: FetchLike;
  /** Default: "https://api.github.com" */
  baseURL?: string;
  /** Default: 8. Non-positive or non-finite values disable pacing. */
  paceRatePerSec?: number;
  /** Default: 8 */
  paceBurst?: number;
  /** Default: 60_000 (60s). Secondary rate-limit waits exceeding this fail immediately. */
  maxSecondaryRetryAfterMs?: number;
  /** Optional sleep override for deterministic testing. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Optional monotonic/wall clock override (ms) for deterministic testing. */
  nowMs?: () => number;
}

export interface GitHubRepository {
  full_name?: string;
  default_branch?: string;
  archived?: boolean;
}

export interface GitHubTreeEntry {
  path?: string;
  type?: string;
}

export interface GitHubTree {
  sha?: string;
  tree?: GitHubTreeEntry[];
  truncated?: boolean;
}

export interface GitHubContentFile {
  type?: string;
  encoding?: string;
  content?: string;
  name?: string;
  path?: string;
}

export interface GitHubAutomatedSecurityFixes {
  enabled?: boolean;
  paused?: boolean;
}

export interface GitHubDependabotAlert {
  number?: number;
  state?: string;
  dependency?: {
    package?: {
      ecosystem?: string;
      name?: string;
    } | null;
    manifest_path?: string;
  } | null;
  security_advisory?: {
    ghsa_id?: string;
    severity?: string;
  } | null;
  security_vulnerability?: {
    severity?: string;
    first_patched_version?: {
      identifier?: string;
    } | null;
  } | null;
  fixed_at?: string | null;
}

export interface GitHubCommit {
  commit?: {
    committer?: {
      date?: string;
    } | null;
  } | null;
}

export interface GitHubUser {
  login?: string;
}

export interface GitHubPullRequest {
  number?: number;
  state?: string;
  title?: string;
  user?: GitHubUser | null;
  created_at?: string;
  merged_at?: string | null;
  mergeable?: boolean | null;
  mergeable_state?: string;
  requested_reviewers?: GitHubUser[] | null;
  head?: {
    ref?: string;
    sha?: string;
  } | null;
  base?: {
    ref?: string;
  } | null;
}

export interface GitHubPullRequestReview {
  id?: number;
  state?: string;
  user?: GitHubUser | null;
  submitted_at?: string;
}

export interface GitHubCheckRun {
  id?: number;
  name?: string;
  status?: string;
  conclusion?: string | null;
}

interface GitHubCheckRunsResponse {
  total_count?: number;
  check_runs?: GitHubCheckRun[];
}

export class GitHubAPIError extends Error {
  readonly status: number;
  readonly method: string;
  readonly url: string;
  readonly apiMessage: string;
  readonly documentationURL?: string;

  constructor(params: {
    status: number;
    statusText: string;
    method: string;
    url: string;
    apiMessage: string;
    documentationURL?: string;
  }) {
    const detail = params.apiMessage || params.statusText || "request failed";
    super(`${params.method} ${params.url}: ${params.status} ${detail}`);
    this.name = "GitHubAPIError";
    this.status = params.status;
    this.method = params.method;
    this.url = params.url;
    this.apiMessage = params.apiMessage;
    this.documentationURL = params.documentationURL;
  }
}

export class GitHubRateLimitError extends GitHubAPIError {
  readonly limit?: number;
  readonly remaining?: number;
  readonly resetAt?: Date;

  constructor(params: {
    status: number;
    statusText: string;
    method: string;
    url: string;
    apiMessage: string;
    documentationURL?: string;
    limit?: number;
    remaining?: number;
    resetAt?: Date;
  }) {
    super(params);
    this.name = "GitHubRateLimitError";
    this.limit = params.limit;
    this.remaining = params.remaining;
    this.resetAt = params.resetAt;
  }
}

export class GitHubSecondaryRateLimitError extends GitHubAPIError {
  readonly retryAfterMs?: number;

  constructor(params: {
    status: number;
    statusText: string;
    method: string;
    url: string;
    apiMessage: string;
    documentationURL?: string;
    retryAfterMs?: number;
  }) {
    super(params);
    this.name = "GitHubSecondaryRateLimitError";
    this.retryAfterMs = params.retryAfterMs;
  }
}

const DEFAULT_BASE_URL = "https://api.github.com";
const DEFAULT_PACE_RATE_PER_SEC = 8;
const DEFAULT_PACE_BURST = 8;
const DEFAULT_MAX_SECONDARY_RETRY_AFTER_MS = 60_000;
const MAX_SECONDARY_RETRIES = 5;
export const PAGE_SIZE = 100;

function abortError(signal?: AbortSignal): unknown {
  if (signal?.reason !== undefined) {
    return signal.reason;
  }
  return new DOMException("The operation was aborted.", "AbortError");
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    if (signal?.aborted) {
      return Promise.reject(abortError(signal));
    }
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly ratePerSec: number,
    private readonly burst: number,
    private readonly nowMs: () => number,
    private readonly sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>,
  ) {
    this.tokens = burst;
    this.lastRefillMs = nowMs();
  }

  wait(signal?: AbortSignal): Promise<void> {
    if (this.ratePerSec <= 0 || !Number.isFinite(this.ratePerSec)) {
      if (signal?.aborted) {
        return Promise.reject(abortError(signal));
      }
      return Promise.resolve();
    }

    const task = this.queue.then(async () => {
      if (signal?.aborted) {
        throw abortError(signal);
      }
      const now = this.nowMs();
      if (now > this.lastRefillMs) {
        const elapsedSec = (now - this.lastRefillMs) / 1000;
        this.tokens = Math.min(this.burst, this.tokens + elapsedSec * this.ratePerSec);
        this.lastRefillMs = now;
      }

      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }

      const deficit = 1 - this.tokens;
      const waitMs = Math.ceil((deficit / this.ratePerSec) * 1000);
      await this.sleepFn(waitMs, signal);

      const after = this.nowMs();
      if (after > this.lastRefillMs) {
        const elapsedSec = (after - this.lastRefillMs) / 1000;
        this.tokens = Math.max(
          0,
          Math.min(this.burst, this.tokens + elapsedSec * this.ratePerSec) - 1,
        );
        this.lastRefillMs = after;
      } else {
        this.tokens = 0;
      }
    });

    this.queue = task.catch(() => {});
    return task;
  }
}

/**
 * Extracts the `rel="next"` target URL from an RFC 8288 Link header.
 */
export function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) {
    return null;
  }
  const pattern = /<([^>]+)>([^,]*)/g;
  for (const match of linkHeader.matchAll(pattern)) {
    const rawURL = match[1]?.trim();
    const params = match[2] ?? "";
    if (!rawURL) {
      continue;
    }
    const relMatch = /;\s*rel\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(params);
    const relValue = relMatch?.[1] ?? relMatch?.[2] ?? "";
    const tokens = relValue.toLowerCase().split(/\s+/);
    if (tokens.includes("next")) {
      return rawURL;
    }
  }
  return null;
}

/**
 * Parses an HTTP Retry-After header (delta-seconds or HTTP-date) into milliseconds.
 */
export function parseRetryAfterMs(value: string | null, nowMs: number): number | undefined {
  if (value === null) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    return undefined;
  }
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  const parsedDate = Date.parse(trimmed);
  if (!Number.isNaN(parsedDate)) {
    return Math.max(0, parsedDate - nowMs);
  }
  return undefined;
}

/**
 * Decodes base64-encoded UTF-8 content (stripping embedded whitespace/newlines
 * as returned by GitHub's repository contents API) using standard Web APIs.
 */
export function decodeBase64UTF8(encoded: string): string {
  const clean = encoded.replace(/\s+/g, "");
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder("utf-8").decode(bytes);
}

function encodePathSegment(segment: string): string {
  return encodeURIComponent(segment);
}

function encodePath(filePath: string): string {
  return filePath.split("/").map(encodeURIComponent).join("/");
}

function parseOptionalInt(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value.trim())) {
    return undefined;
  }
  return Number(value.trim());
}

async function readErrorBody(res: Response): Promise<{
  message: string;
  documentationURL?: string;
}> {
  const text = await res.text();
  if (text === "") {
    return { message: "" };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const message = typeof record["message"] === "string" ? record["message"] : "";
      const documentationURL =
        typeof record["documentation_url"] === "string" ? record["documentation_url"] : undefined;
      return { message, documentationURL };
    }
  } catch {
    // Non-JSON response body (e.g. proxy HTML error page).
  }
  return { message: text.trim().slice(0, 200) };
}

export class GitHubClient {
  private readonly token: string;
  private readonly fetchFn: FetchLike;
  private readonly baseURL: string;
  private readonly baseOrigin: string;
  private readonly maxSecondaryRetryAfterMs: number;
  private readonly sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly nowMs: () => number;
  private readonly bucket: TokenBucket;

  constructor(opts: GitHubClientOptions) {
    this.token = opts.token;
    this.fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);
    const rawBase = (opts.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.baseURL = rawBase;
    this.baseOrigin = new URL(rawBase).origin;
    this.maxSecondaryRetryAfterMs =
      opts.maxSecondaryRetryAfterMs ?? DEFAULT_MAX_SECONDARY_RETRY_AFTER_MS;
    this.sleepFn = opts.sleep ?? defaultSleep;
    this.nowMs = opts.nowMs ?? Date.now;

    const rate = opts.paceRatePerSec ?? DEFAULT_PACE_RATE_PER_SEC;
    const burst = Math.max(1, opts.paceBurst ?? DEFAULT_PACE_BURST);
    this.bucket = new TokenBucket(rate, burst, this.nowMs, this.sleepFn);
  }

  private buildURL(path: string, params?: Record<string, string | number | undefined>): string {
    const base = `${this.baseURL}${path}`;
    if (!params) {
      return base;
    }
    const search = new URLSearchParams();
    const keys = Object.keys(params).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const key of keys) {
      const val = params[key];
      if (val !== undefined) {
        search.append(key, String(val));
      }
    }
    const query = search.toString();
    return query === "" ? base : `${base}?${query}`;
  }

  private resolveNextPageURL(linkHeader: string | null): string | null {
    const rawNext = parseNextLink(linkHeader);
    if (rawNext === null) {
      return null;
    }
    const nextURL = new URL(rawNext, `${this.baseURL}/`);
    if (nextURL.origin !== this.baseOrigin) {
      throw new Error(`refusing cross-origin pagination link: ${nextURL.origin}`);
    }
    // Match go-github's url.Values.Encode() alphabetical query ordering.
    nextURL.searchParams.sort();
    return nextURL.toString();
  }

  private async requestJSON<T>(
    url: string,
    signal?: AbortSignal,
  ): Promise<{ data: T; linkHeader: string | null }> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github.v3+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "depatrol",
    };
    if (this.token !== "") {
      headers["Authorization"] = `Bearer ${this.token}`;
    }

    for (let attempt = 0; ; attempt++) {
      await this.bucket.wait(signal);

      const init: RequestInit = {
        method: "GET",
        headers,
      };
      if (signal !== undefined) {
        init.signal = signal;
      }

      const res = await this.fetchFn(url, init);
      if (res.ok) {
        const data = (await res.json()) as T;
        return { data, linkHeader: res.headers.get("link") };
      }

      const body = await readErrorBody(res);
      const lowerMsg = body.message.toLowerCase();
      const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"), this.nowMs());

      const isSecondary =
        (res.status === 403 || res.status === 429) &&
        (retryAfterMs !== undefined ||
          lowerMsg.includes("secondary rate limit") ||
          lowerMsg.includes("abuse detection"));

      if (isSecondary) {
        if (
          retryAfterMs !== undefined &&
          this.maxSecondaryRetryAfterMs > 0 &&
          retryAfterMs <= this.maxSecondaryRetryAfterMs &&
          attempt < MAX_SECONDARY_RETRIES
        ) {
          await this.sleepFn(retryAfterMs, signal);
          continue;
        }
        throw new GitHubSecondaryRateLimitError({
          status: res.status,
          statusText: res.statusText,
          method: "GET",
          url,
          apiMessage: body.message,
          documentationURL: body.documentationURL,
          retryAfterMs,
        });
      }

      const remaining = parseOptionalInt(res.headers.get("x-ratelimit-remaining"));
      const isPrimaryRateLimit =
        res.status === 403 &&
        (remaining === 0 || lowerMsg.includes("api rate limit exceeded"));

      if (isPrimaryRateLimit) {
        const limit = parseOptionalInt(res.headers.get("x-ratelimit-limit"));
        const resetSec = parseOptionalInt(res.headers.get("x-ratelimit-reset"));
        throw new GitHubRateLimitError({
          status: res.status,
          statusText: res.statusText,
          method: "GET",
          url,
          apiMessage: body.message,
          documentationURL: body.documentationURL,
          limit,
          remaining,
          resetAt: resetSec !== undefined ? new Date(resetSec * 1000) : undefined,
        });
      }

      throw new GitHubAPIError({
        status: res.status,
        statusText: res.statusText,
        method: "GET",
        url,
        apiMessage: body.message,
        documentationURL: body.documentationURL,
      });
    }
  }

  private async paginateArray<T>(initialURL: string, signal?: AbortSignal): Promise<T[]> {
    const items: T[] = [];
    const visited = new Set<string>();
    let url: string | null = initialURL;

    while (url !== null) {
      if (visited.has(url)) {
        break;
      }
      visited.add(url);

      const { data, linkHeader } = await this.requestJSON<T[]>(url, signal);
      if (Array.isArray(data)) {
        items.push(...data);
      }
      url = this.resolveNextPageURL(linkHeader);
    }

    return items;
  }

  async listOrgRepositories(org: string, signal?: AbortSignal): Promise<GitHubRepository[]> {
    const url = this.buildURL(`/orgs/${encodePathSegment(org)}/repos`, {
      per_page: PAGE_SIZE,
    });
    return this.paginateArray<GitHubRepository>(url, signal);
  }

  async getRepository(
    owner: string,
    name: string,
    signal?: AbortSignal,
  ): Promise<GitHubRepository> {
    const url = this.buildURL(`/repos/${encodePathSegment(owner)}/${encodePathSegment(name)}`);
    const { data } = await this.requestJSON<GitHubRepository>(url, signal);
    return data;
  }

  async getGitTree(
    owner: string,
    name: string,
    ref: string,
    recursive: boolean,
    signal?: AbortSignal,
  ): Promise<GitHubTree> {
    const url = this.buildURL(
      `/repos/${encodePathSegment(owner)}/${encodePathSegment(name)}/git/trees/${encodePath(ref)}`,
      recursive ? { recursive: 1 } : undefined,
    );
    const { data } = await this.requestJSON<GitHubTree>(url, signal);
    return data;
  }

  async getFileContent(
    owner: string,
    name: string,
    filePath: string,
    ref: string,
    signal?: AbortSignal,
  ): Promise<GitHubContentFile | null> {
    const url = this.buildURL(
      `/repos/${encodePathSegment(owner)}/${encodePathSegment(name)}/contents/${encodePath(filePath)}`,
      { ref },
    );
    try {
      const { data } = await this.requestJSON<GitHubContentFile | GitHubContentFile[]>(url, signal);
      if (Array.isArray(data)) {
        throw new Error(`${filePath} is a directory, not a file`);
      }
      return data;
    } catch (err) {
      if (err instanceof GitHubAPIError && err.status === 404) {
        return null;
      }
      throw err;
    }
  }

  async getAutomatedSecurityFixes(
    owner: string,
    name: string,
    signal?: AbortSignal,
  ): Promise<GitHubAutomatedSecurityFixes | null> {
    const url = this.buildURL(
      `/repos/${encodePathSegment(owner)}/${encodePathSegment(name)}/automated-security-fixes`,
    );
    try {
      const { data } = await this.requestJSON<GitHubAutomatedSecurityFixes>(url, signal);
      return data;
    } catch (err) {
      if (err instanceof GitHubAPIError && err.status === 404) {
        return null;
      }
      throw err;
    }
  }

  async listRepoAlerts(
    owner: string,
    name: string,
    state: string,
    signal?: AbortSignal,
  ): Promise<GitHubDependabotAlert[]> {
    const url = this.buildURL(
      `/repos/${encodePathSegment(owner)}/${encodePathSegment(name)}/dependabot/alerts`,
      { per_page: PAGE_SIZE, state },
    );
    return this.paginateArray<GitHubDependabotAlert>(url, signal);
  }

  async listCommits(
    owner: string,
    name: string,
    author: string,
    perPage: number,
    signal?: AbortSignal,
  ): Promise<GitHubCommit[] | null> {
    const url = this.buildURL(
      `/repos/${encodePathSegment(owner)}/${encodePathSegment(name)}/commits`,
      { author, per_page: perPage },
    );
    try {
      const { data } = await this.requestJSON<GitHubCommit[]>(url, signal);
      return Array.isArray(data) ? data : [];
    } catch (err) {
      // 409 means the repository has no commits at all.
      if (err instanceof GitHubAPIError && err.status === 409) {
        return null;
      }
      throw err;
    }
  }

  async listPullRequests(
    owner: string,
    name: string,
    state: string,
    signal?: AbortSignal,
  ): Promise<GitHubPullRequest[]> {
    const url = this.buildURL(
      `/repos/${encodePathSegment(owner)}/${encodePathSegment(name)}/pulls`,
      { per_page: PAGE_SIZE, state },
    );
    return this.paginateArray<GitHubPullRequest>(url, signal);
  }

  async getPullRequest(
    owner: string,
    name: string,
    number: number,
    signal?: AbortSignal,
  ): Promise<GitHubPullRequest> {
    const url = this.buildURL(
      `/repos/${encodePathSegment(owner)}/${encodePathSegment(name)}/pulls/${number}`,
    );
    const { data } = await this.requestJSON<GitHubPullRequest>(url, signal);
    return data;
  }

  async listPullRequestReviews(
    owner: string,
    name: string,
    number: number,
    signal?: AbortSignal,
  ): Promise<GitHubPullRequestReview[]> {
    const url = this.buildURL(
      `/repos/${encodePathSegment(owner)}/${encodePathSegment(name)}/pulls/${number}/reviews`,
      { per_page: PAGE_SIZE },
    );
    return this.paginateArray<GitHubPullRequestReview>(url, signal);
  }

  async listCheckRunsForRef(
    owner: string,
    name: string,
    ref: string,
    signal?: AbortSignal,
  ): Promise<GitHubCheckRun[]> {
    // Keep GitHub's default page size on the first request (no per_page) so
    // existing API recordings remain representative; every advertised next page is read.
    const initialURL = this.buildURL(
      `/repos/${encodePathSegment(owner)}/${encodePathSegment(name)}/commits/${encodePath(ref)}/check-runs`,
    );
    const runs: GitHubCheckRun[] = [];
    const visited = new Set<string>();
    let url: string | null = initialURL;

    while (url !== null) {
      if (visited.has(url)) {
        break;
      }
      visited.add(url);

      const { data, linkHeader } = await this.requestJSON<GitHubCheckRunsResponse>(url, signal);
      if (Array.isArray(data.check_runs)) {
        runs.push(...data.check_runs);
      }
      url = this.resolveNextPageURL(linkHeader);
    }

    return runs;
  }
}

export function createGitHubClient(opts: GitHubClientOptions): GitHubClient {
  return new GitHubClient(opts);
}
