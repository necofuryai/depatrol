import { describe, expect, test } from "bun:test";
import { run, type Writable } from "../src/cli/cli.ts";
import { formatBuildVersion, resolveBuildVersion } from "../src/cli/version.ts";

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

describe("version formatting", () => {
  test("formatBuildVersion matches main.go buildVersion() contract", () => {
    expect(formatBuildVersion()).toBe("(devel)");
    expect(formatBuildVersion({ version: "", commit: "", date: "" })).toBe("(devel)");
    expect(formatBuildVersion({ version: "1.2.3" })).toBe("1.2.3");
    expect(formatBuildVersion({ version: "0.2.0", commit: "abc1234" })).toBe(
      "0.2.0 (commit abc1234)",
    );
    expect(
      formatBuildVersion({
        version: "0.2.0",
        commit: "abc1234",
        date: "2026-11-19T00:00:00Z",
      }),
    ).toBe("0.2.0 (commit abc1234, commit date 2026-11-19T00:00:00Z)");
    expect(
      formatBuildVersion({
        commit: "abc1234",
        date: "2026-11-19T00:00:00Z",
      }),
    ).toBe("(devel) (commit abc1234, commit date 2026-11-19T00:00:00Z)");
    expect(formatBuildVersion({ version: "0.2.0", date: "2026-11-19T00:00:00Z" })).toBe("0.2.0");
  });

  test("resolveBuildVersion falls back to (devel) when compile-time defines are absent", () => {
    expect(resolveBuildVersion()).toBe("(devel)");
  });
});

describe("CLI --version flag", () => {
  test("prints injected version with --version", async () => {
    const stdout = createBuffer();
    const stderr = createBuffer();
    const code = await run(["--version"], { version: "1.2.3", stdout, stderr });
    expect(code).toBe(0);
    expect(stdout.text()).toBe("depatrol version 1.2.3\n");
    expect(stderr.text()).toBe("");
  });

  test("prints injected version with -v", async () => {
    const stdout = createBuffer();
    const stderr = createBuffer();
    const code = await run(["-v"], {
      version: "0.2.0 (commit deadbeef, commit date 2026-11-19T00:00:00Z)",
      stdout,
      stderr,
    });
    expect(code).toBe(0);
    expect(stdout.text()).toBe(
      "depatrol version 0.2.0 (commit deadbeef, commit date 2026-11-19T00:00:00Z)\n",
    );
    expect(stderr.text()).toBe("");
  });

  test("falls back to (devel) when version is not injected", async () => {
    const stdout = createBuffer();
    const stderr = createBuffer();
    const code = await run(["--version"], { stdout, stderr });
    expect(code).toBe(0);
    expect(stdout.text()).toBe("depatrol version (devel)\n");
    expect(stderr.text()).toBe("");
  });
});
