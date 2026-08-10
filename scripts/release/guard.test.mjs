import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const guardScript = resolve(here, "guard.sh");

function run(command, args, cwd, env = process.env) {
  return spawnSync(command, args, { cwd, env, encoding: "utf8" });
}

function repository() {
  const root = mkdtempSync(join(tmpdir(), "depatrol-guard-test-"));
  assert.equal(run("git", ["init", "-b", "main"], root).status, 0);
  assert.equal(run("git", ["config", "user.name", "Test"], root).status, 0);
  assert.equal(
    run("git", ["config", "user.email", "test@example.invalid"], root).status,
    0,
  );
  assert.equal(run("git", ["config", "commit.gpgsign", "false"], root).status, 0);
  assert.equal(run("git", ["config", "tag.gpgSign", "false"], root).status, 0);
  writeFileSync(join(root, "README.md"), "fixture\n");
  assert.equal(run("git", ["add", "README.md"], root).status, 0);
  assert.equal(run("git", ["commit", "-m", "fixture"], root).status, 0);
  return root;
}

function runGuard(root, tag) {
  const env = { ...process.env };
  delete env.GITHUB_ACTIONS;
  return run("/bin/bash", [guardScript, tag], root, env);
}

test("rejects a tag that is not exact stable SemVer", () => {
  const root = repository();
  try {
    const result = runGuard(root, "v1.2.3-rc.1");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not exact stable SemVer/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a lightweight tag", () => {
  const root = repository();
  try {
    assert.equal(run("git", ["tag", "v1.2.3"], root).status, 0);
    const result = runGuard(root, "v1.2.3");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not an annotated tag/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a tag when the hardening marker is absent", () => {
  const root = repository();
  try {
    assert.equal(
      run("git", ["tag", "-a", "v1.2.3", "-m", "fixture"], root).status,
      0,
    );
    const result = runGuard(root, "v1.2.3");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /baseline marker is missing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
