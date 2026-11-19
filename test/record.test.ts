import { describe, expect, test } from "bun:test";
import { basename } from "node:path";
import {
  EMPTY_CLONE_TOKEN,
  SCRUBBED_REQUEST_HEADERS,
  SCRUBBED_RESPONSE_HEADERS,
  createCassetteReplayer,
  findHeaderCaseInsensitive,
  findScrubViolations,
  listCassetteFiles,
  loadCassette,
  scrubInteraction,
  type CassetteInteraction,
} from "./helpers/cassette.ts";

describe("committed cassettes scrub verification", () => {
  const cassettePaths = listCassetteFiles();

  test("contains all 20 committed YAML cassettes", () => {
    expect(cassettePaths.length).toBe(20);
  });

  for (const cassettePath of cassettePaths) {
    const name = basename(cassettePath, ".yaml");
    test(`cassette ${name} is scrubbed of credentials and session metadata`, () => {
      const cassette = loadCassette(cassettePath);
      expect(cassette.interactions.length).toBeGreaterThan(0);
      expect(findScrubViolations(cassette)).toEqual([]);
    });
  }

  test("preserves rate-limit response headers needed by alerts_rate_limited", () => {
    const cassette = loadCassette("alerts_rate_limited");
    const limited = cassette.interactions.find((i) => i.response.code === 403);
    expect(limited).toBeDefined();
    const remaining = findHeaderCaseInsensitive(limited!.response.headers, "X-RateLimit-Remaining");
    expect(remaining?.values).toEqual(["0"]);
    const reset = findHeaderCaseInsensitive(limited!.response.headers, "X-RateLimit-Reset");
    expect(reset?.values.length).toBeGreaterThan(0);
  });
});

describe("scrubInteraction", () => {
  test("strips Authorization, all session response headers, and non-empty temp_clone_token while keeping rate-limit headers", () => {
    const interaction: CassetteInteraction = {
      id: 0,
      request: {
        method: "GET",
        url: "https://api.github.com/repos/acme/private",
        headers: {
          Authorization: ["Bearer ghp_secret_token"],
          Accept: ["application/vnd.github+json"],
        },
      },
      response: {
        code: 200,
        status: "200 OK",
        headers: {
          "Content-Type": ["application/json; charset=utf-8"],
          "X-Accepted-Oauth-Scopes": ["repo"],
          "X-Github-Edge-Region": ["nrt"],
          "X-Github-Request-Id": ["ABCD:1234:5678"],
          "X-Oauth-Client-Id": ["Iv1.123456"],
          "X-Oauth-Scopes": ["repo, security_events"],
          "X-Ratelimit-Remaining": ["4999"],
          "X-Ratelimit-Reset": ["1785562000"],
        },
        body: '{"full_name":"acme/private","temp_clone_token":"SECRET_TOKEN_VALUE","other":"ok"}',
      },
    };

    const beforeViolations = findScrubViolations({ version: 2, interactions: [interaction] });
    expect(beforeViolations.length).toBe(
      SCRUBBED_REQUEST_HEADERS.length + SCRUBBED_RESPONSE_HEADERS.length + 1,
    );

    scrubInteraction(interaction);

    expect(findScrubViolations({ version: 2, interactions: [interaction] })).toEqual([]);
    expect(interaction.request.headers.Accept).toEqual(["application/vnd.github+json"]);
    expect(interaction.response.headers["X-Ratelimit-Remaining"]).toEqual(["4999"]);
    expect(interaction.response.headers["X-Ratelimit-Reset"]).toEqual(["1785562000"]);
    expect(interaction.response.body).toContain(EMPTY_CLONE_TOKEN);
    expect(interaction.response.body).not.toContain("SECRET_TOKEN_VALUE");
  });

  test("matches headers case-insensitively and rejects all non-empty temp_clone_token occurrences", () => {
    const interaction: CassetteInteraction = {
      id: 7,
      request: {
        method: "GET",
        url: "https://api.github.com/repos/acme/private",
        headers: { authorization: ["Bearer secret"] },
      },
      response: {
        code: 200,
        status: "200 OK",
        headers: { "x-github-request-id": ["req-1"] },
        body: '[{"temp_clone_token":""},{"temp_clone_token":"leaked\\"token"}]',
      },
    };

    const violations = findScrubViolations({ version: 2, interactions: [interaction] });
    expect(violations).toHaveLength(3);

    scrubInteraction(interaction);
    expect(findScrubViolations({ version: 2, interactions: [interaction] })).toEqual([]);
    expect(interaction.response.body).toBe('[{"temp_clone_token":""},{"temp_clone_token":""}]');
  });
});

describe("cassette replayer", () => {
  test("matches order-independent query parameters, ignores request headers, and fails closed on unexpected requests", async () => {
    const replayer = createCassetteReplayer("alert_pending");

    const res = await replayer.fetch(
      "https://api.github.com/repos/acme/vulnpending/dependabot/alerts?state=open&per_page=100",
      {
        method: "GET",
        headers: { Authorization: "Bearer ignored-in-match", "X-Custom": "noise" },
      },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    const body = (await res.json()) as Array<{ number: number }>;
    expect(body[0]?.number).toBe(12);

    // Same interaction cannot be replayed twice once consumed.
    await expect(
      replayer.fetch(
        "https://api.github.com/repos/acme/vulnpending/dependabot/alerts?per_page=100&state=open",
      ),
    ).rejects.toThrow("no unused interaction matching");

    // Completely unregistered host/path fails closed immediately.
    await expect(
      replayer.fetch("https://api.github.com/repos/acme/does-not-exist"),
    ).rejects.toThrow("no unused interaction matching");
  });
});
