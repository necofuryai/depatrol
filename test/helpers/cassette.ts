import { readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

export type CassetteFetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type HeaderMap = Record<string, string[]>;

export interface CassetteRequest {
  proto?: string;
  proto_major?: number;
  proto_minor?: number;
  content_length?: number;
  host?: string;
  body?: string;
  headers: HeaderMap;
  url: string;
  method: string;
}

export interface CassetteResponse {
  proto?: string;
  proto_major?: number;
  proto_minor?: number;
  content_length?: number;
  uncompressed?: boolean;
  body: string;
  headers: HeaderMap;
  status: string;
  code: number;
}

export interface CassetteInteraction {
  id: number;
  request: CassetteRequest;
  response: CassetteResponse;
}

export interface Cassette {
  version: number;
  interactions: CassetteInteraction[];
}

export interface RecordedRequest {
  method: string;
  url: string;
  interactionId: number;
}

export interface CassetteReplayer {
  readonly fetch: CassetteFetchLike;
  readonly requests: readonly RecordedRequest[];
  readonly totalInteractions: number;
  usedCount(): number;
}

export const CASSETTES_DIR = fileURLToPath(new URL("../fixtures/cassettes", import.meta.url));

/**
 * Request headers that carry credentials and must never be committed in cassettes.
 */
export const SCRUBBED_REQUEST_HEADERS = ["Authorization"] as const;

/**
 * Response headers that describe the recording session rather than the API
 * payload. Rate-limit headers are deliberately kept because scan.ts relies on
 * them (e.g. alerts_rate_limited.yaml).
 */
export const SCRUBBED_RESPONSE_HEADERS = [
  "X-Accepted-Oauth-Scopes",
  "X-Github-Edge-Region",
  "X-Github-Request-Id",
  "X-Oauth-Client-Id",
  "X-Oauth-Scopes",
] as const;

/**
 * Matches GitHub's temp_clone_token field. Empty for public repositories, but
 * carries a real clone credential otherwise — blanked rather than trusted.
 */
export const TEMP_CLONE_TOKEN_REGEX = /"temp_clone_token":"(?:[^"\\]|\\.)*"/g;
export const EMPTY_CLONE_TOKEN = '"temp_clone_token":""';

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeHeaderMap(raw: unknown): HeaderMap {
  if (!isRecord(raw)) {
    return {};
  }
  const result: HeaderMap = {};
  for (const [key, value] of Object.entries(raw)) {
    if (Array.isArray(value)) {
      result[key] = value.map((item) => String(item));
    } else if (value !== undefined && value !== null) {
      result[key] = [String(value)];
    }
  }
  return result;
}

/**
 * Lists all committed `.yaml` cassette paths in deterministic sorted order.
 */
export function listCassetteFiles(dir: string = CASSETTES_DIR): string[] {
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".yaml"))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((entry) => join(dir, entry));
}

export function resolveCassettePath(nameOrPath: string): string {
  if (isAbsolute(nameOrPath)) {
    return nameOrPath;
  }
  const filename = nameOrPath.endsWith(".yaml") ? nameOrPath : `${nameOrPath}.yaml`;
  return join(CASSETTES_DIR, filename);
}

/**
 * Loads a go-vcr v4 YAML cassette file into a typed structure.
 */
export function loadCassette(nameOrPath: string): Cassette {
  const path = resolveCassettePath(nameOrPath);
  const content = readFileSync(path, "utf8");
  const parsed: unknown = parse(content);
  if (!isRecord(parsed) || !Array.isArray(parsed.interactions)) {
    throw new Error(`Invalid cassette format in ${path}: expected interactions array`);
  }

  const interactions: CassetteInteraction[] = parsed.interactions.map((rawItem, idx) => {
    if (!isRecord(rawItem) || !isRecord(rawItem.request) || !isRecord(rawItem.response)) {
      throw new Error(`Invalid interaction at index ${idx} in ${path}`);
    }
    const req = rawItem.request;
    const res = rawItem.response;
    if (typeof req.url !== "string" || typeof req.method !== "string") {
      throw new Error(`Invalid interaction request at index ${idx} in ${path}`);
    }
    if (typeof res.code !== "number") {
      throw new Error(`Invalid interaction response code at index ${idx} in ${path}`);
    }

    return {
      id: typeof rawItem.id === "number" ? rawItem.id : idx,
      request: {
        ...(typeof req.proto === "string" ? { proto: req.proto } : {}),
        ...(typeof req.proto_major === "number" ? { proto_major: req.proto_major } : {}),
        ...(typeof req.proto_minor === "number" ? { proto_minor: req.proto_minor } : {}),
        ...(typeof req.content_length === "number" ? { content_length: req.content_length } : {}),
        ...(typeof req.host === "string" ? { host: req.host } : {}),
        ...(typeof req.body === "string" ? { body: req.body } : {}),
        headers: normalizeHeaderMap(req.headers),
        url: req.url,
        method: req.method,
      },
      response: {
        ...(typeof res.proto === "string" ? { proto: res.proto } : {}),
        ...(typeof res.proto_major === "number" ? { proto_major: res.proto_major } : {}),
        ...(typeof res.proto_minor === "number" ? { proto_minor: res.proto_minor } : {}),
        ...(typeof res.content_length === "number" ? { content_length: res.content_length } : {}),
        ...(typeof res.uncompressed === "boolean" ? { uncompressed: res.uncompressed } : {}),
        body: typeof res.body === "string" ? res.body : "",
        headers: normalizeHeaderMap(res.headers),
        status: typeof res.status === "string" ? res.status : String(res.code),
        code: res.code,
      },
    };
  });

  return {
    version: typeof parsed.version === "number" ? parsed.version : 2,
    interactions,
  };
}

/**
 * Canonicalizes query parameters in order-independent key-sorted order,
 * matching Go's `url.Values.Encode()`.
 */
export function canonicalQuery(params: URLSearchParams): string {
  const entries = [...params.entries()].sort(([aKey], [bKey]) =>
    aKey < bKey ? -1 : aKey > bKey ? 1 : 0,
  );
  const canonical = new URLSearchParams();
  for (const [key, value] of entries) {
    canonical.append(key, value);
  }
  return canonical.toString();
}

/**
 * Matches on HTTP method, host, path, and order-independent query string.
 * Request headers are intentionally ignored (matching internal/cli/cli_test.go).
 */
export function matchCassetteRequest(
  method: string,
  requestUrl: string,
  recorded: CassetteRequest,
): boolean {
  if (method.toUpperCase() !== recorded.method.toUpperCase()) {
    return false;
  }
  let actual: URL;
  let want: URL;
  try {
    actual = new URL(requestUrl);
    want = new URL(recorded.url);
  } catch {
    return false;
  }
  return (
    actual.host === want.host &&
    actual.pathname === want.pathname &&
    canonicalQuery(actual.searchParams) === canonicalQuery(want.searchParams)
  );
}

function extractRequestInfo(input: string | URL | Request, init?: RequestInit): { method: string; url: string } {
  if (typeof input === "string") {
    return { method: (init?.method ?? "GET").toUpperCase(), url: input };
  }
  if (input instanceof URL) {
    return { method: (init?.method ?? "GET").toUpperCase(), url: input.toString() };
  }
  return {
    method: (init?.method ?? input.method ?? "GET").toUpperCase(),
    url: input.url,
  };
}

function parseStatusText(status: string, code: number): string {
  const prefix = `${code} `;
  return status.startsWith(prefix) ? status.slice(prefix.length) : status;
}

function buildResponse(recorded: CassetteResponse): Response {
  const headers = new Headers();
  for (const [name, values] of Object.entries(recorded.headers)) {
    for (const value of values) {
      headers.append(name, value);
    }
  }
  const body = NULL_BODY_STATUSES.has(recorded.code) ? null : recorded.body;
  return new Response(body, {
    status: recorded.code,
    statusText: parseStatusText(recorded.status, recorded.code),
    headers,
  });
}

/**
 * Creates a strictly offline, replay-only FetchLike backed by a recorded
 * go-vcr v4 cassette. Every recorded interaction can be consumed at most once,
 * and any unexpected request immediately throws without touching the network.
 */
export function createCassetteReplayer(nameOrPath: string): CassetteReplayer {
  const cassette = loadCassette(nameOrPath);
  const used = new Array<boolean>(cassette.interactions.length).fill(false);
  const requests: RecordedRequest[] = [];

  const fetch: CassetteFetchLike = async (input, init) => {
    const { method, url } = extractRequestInfo(input, init);
    for (let i = 0; i < cassette.interactions.length; i += 1) {
      if (used[i]) {
        continue;
      }
      const interaction = cassette.interactions[i];
      if (interaction && matchCassetteRequest(method, url, interaction.request)) {
        used[i] = true;
        requests.push({ method, url, interactionId: interaction.id });
        return buildResponse(interaction.response);
      }
    }

    const remaining = cassette.interactions
      .filter((_, idx) => !used[idx])
      .map((item) => `  - [${item.id}] ${item.request.method} ${item.request.url}`)
      .join("\n");
    throw new Error(
      `Cassette ${JSON.stringify(nameOrPath)} has no unused interaction matching ${method} ${url}\nRemaining unused interactions:\n${remaining || "  (none)"}`,
    );
  };

  return {
    fetch,
    requests,
    totalInteractions: cassette.interactions.length,
    usedCount: () => used.filter(Boolean).length,
  };
}

export function findHeaderCaseInsensitive(
  headers: HeaderMap,
  targetName: string,
): { name: string; values: string[] } | undefined {
  const lower = targetName.toLowerCase();
  for (const [name, values] of Object.entries(headers)) {
    if (name.toLowerCase() === lower) {
      return { name, values };
    }
  }
  return undefined;
}

function deleteHeaderCaseInsensitive(headers: HeaderMap, targetName: string): void {
  const lower = targetName.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) {
      delete headers[key];
    }
  }
}

/**
 * Strips credentials and recording-session metadata from an interaction.
 * Single definition of "clean" shared by recording hooks and scrub tests.
 */
export function scrubInteraction(interaction: CassetteInteraction): void {
  for (const header of SCRUBBED_REQUEST_HEADERS) {
    deleteHeaderCaseInsensitive(interaction.request.headers, header);
  }
  for (const header of SCRUBBED_RESPONSE_HEADERS) {
    deleteHeaderCaseInsensitive(interaction.response.headers, header);
  }
  interaction.response.body = interaction.response.body.replace(
    TEMP_CLONE_TOKEN_REGEX,
    EMPTY_CLONE_TOKEN,
  );
}

/**
 * Audits every interaction in a cassette against the scrub policy and returns
 * a list of human-readable violation descriptions (empty when clean).
 */
export function findScrubViolations(cassette: Cassette): string[] {
  const violations: string[] = [];
  for (const interaction of cassette.interactions) {
    for (const header of SCRUBBED_REQUEST_HEADERS) {
      const found = findHeaderCaseInsensitive(interaction.request.headers, header);
      if (found && found.values.some((v) => v !== "")) {
        violations.push(`interaction ${interaction.id}: ${header} request header present`);
      }
    }
    for (const header of SCRUBBED_RESPONSE_HEADERS) {
      const found = findHeaderCaseInsensitive(interaction.response.headers, header);
      if (found && found.values.some((v) => v !== "")) {
        violations.push(
          `interaction ${interaction.id}: response header ${header} present: ${JSON.stringify(found.values)}`,
        );
      }
    }
    const matches = interaction.response.body.match(TEMP_CLONE_TOKEN_REGEX) ?? [];
    for (const match of matches) {
      if (match !== EMPTY_CLONE_TOKEN) {
        violations.push(`interaction ${interaction.id}: non-empty temp_clone_token in response body`);
      }
    }
  }
  return violations;
}
