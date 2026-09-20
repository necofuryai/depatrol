import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const platforms = [
  "cli-darwin-arm64",
  "cli-darwin-x64",
  "cli-linux-arm64",
  "cli-linux-x64",
  "cli-win32-x64",
];

// prepare.mjs stages into <script>/dist and reads the license from
// <script>/../../LICENSE, so the fixture mirrors that layout under a temp
// directory instead of writing into the working tree.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "depatrol-prepare-test-"));
  writeFileSync(join(root, "LICENSE"), "Apache-2.0 placeholder\n");
  const npmDir = join(root, "packaging", "npm");
  mkdirSync(npmDir, { recursive: true });
  cpSync(resolve(here, "prepare.mjs"), join(npmDir, "prepare.mjs"));
  cpSync(resolve(here, "depatrol"), join(npmDir, "depatrol"), {
    recursive: true,
  });
  return { root, script: join(npmDir, "prepare.mjs"), dist: join(npmDir, "dist") };
}

function stage(data, version) {
  const result = spawnSync(process.execPath, [data.script, version, "--stub"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return (entry) =>
    JSON.parse(readFileSync(join(data.dist, entry, "package.json"), "utf8"));
}

function template() {
  return JSON.parse(
    readFileSync(join(here, "depatrol", "package.json"), "utf8"),
  );
}

test("platform packages declare os and cpu but never engines", () => {
  const data = fixture();
  try {
    const manifest = stage(data, "9.9.9");
    for (const entry of platforms) {
      const platform = manifest(entry);
      assert.equal(platform.os?.length, 1, entry);
      assert.equal(platform.cpu?.length, 1, entry);
      // npm skips an optionalDependency whose engines do not match the
      // running Node without printing a warning, which would surface an
      // engine mismatch as a missing platform package. The floor belongs
      // to the main package alone (runbook: npm package layout).
      assert.equal(
        platform.engines,
        undefined,
        `${entry} must not declare engines`,
      );
    }
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
});

test("the main package carries the template's Node floor", () => {
  const data = fixture();
  try {
    const manifest = stage(data, "9.9.9");
    const main = manifest("depatrol");
    assert.deepEqual(main.engines, template().engines);
    assert.equal(main.version, "9.9.9");
    assert.equal(main.private, undefined, "the template guard must be dropped");
    // A ratchet, not a freshness check: Node 22 is the oldest line still
    // under maintenance today, and the runbook rule only ever raises the
    // floor. Lowering it would re-advertise an end-of-life runtime.
    const floor = main.engines?.node ?? "";
    assert.match(floor, /^>=\d+$/, "the floor stays a bare major");
    assert.ok(Number(floor.slice(2)) >= 22, `floor ${floor} is below Node 22`);
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
});
