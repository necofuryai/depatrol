import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { computeSri, createBundle } from "./artifacts.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const publishScript = resolve(here, "publish-npm.mjs");
const TAG = "v0.2.0";
const VERSION = "0.2.0";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

function createTestTarball(destPath, pkgOverrides = {}) {
  const stageRoot = mkdtempSync(join(tmpdir(), "depatrol-tgz-fixture-"));
  try {
    const pkgDir = join(stageRoot, "package");
    mkdirSync(join(pkgDir, "dist"), { recursive: true });
    const manifest = {
      name: "depatrol",
      version: VERSION,
      description: "Read-only control plane for Dependabot across GitHub repositories",
      license: "Apache-2.0",
      type: "module",
      bin: { depatrol: "./dist/depatrol.js" },
      files: ["dist/depatrol.js", "LICENSE", "README.md"],
      engines: { node: ">=22" },
      ...pkgOverrides,
    };
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
    writeFileSync(join(pkgDir, "dist", "depatrol.js"), "#!/usr/bin/env node\nconsole.log('ok');\n");
    writeFileSync(join(pkgDir, "LICENSE"), "Apache-2.0\n");
    writeFileSync(join(pkgDir, "README.md"), "# depatrol\n");
    execFileSync("tar", ["-czf", destPath, "-C", stageRoot, "package"]);
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
  }
}

function fixture(pkgOverrides = {}, npmVersion = "11.19.0") {
  const root = mkdtempSync(join(tmpdir(), "depatrol-publish-npm-test-"));
  const dist = join(root, "dist");
  const bundle = join(root, "bundle");
  const notes = join(root, "notes.md");
  const bin = join(root, "bin");
  const log = join(root, "npm.log");
  mkdirSync(dist);
  mkdirSync(bin);
  writeFileSync(notes, "## Changes\n");

  const tarballPath = join(dist, "depatrol-" + VERSION + ".tgz");
  createTestTarball(tarballPath, pkgOverrides);
  const sri = computeSri(tarballPath);
  createBundle(dist, bundle, TAG, COMMIT, notes);

  const fakeNpm = [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const args = process.argv.slice(2);",
    `if (args[0] === '--version') { console.log(${JSON.stringify(npmVersion)}); process.exit(0); }`,
    "if (args[0] === 'view') {",
    "  if (process.env.FAKE_NPM_SCENARIO === 'missing') { console.error('npm error code E404'); process.exit(1); }",
    "  if (process.env.FAKE_NPM_SCENARIO === 'registry-error') { console.error('npm error code E500'); process.exit(1); }",
    "  if (process.env.FAKE_NPM_SCENARIO === 'mismatch') { console.log(JSON.stringify('sha512-mismatch')); process.exit(0); }",
    `  console.log(JSON.stringify(${JSON.stringify(sri)}));`,
    "  process.exit(0);",
    "}",
    "if (args[0] === 'publish') {",
    "  fs.appendFileSync(process.env.FAKE_NPM_LOG, args.join(' ') + '\\n');",
    "  process.exit(0);",
    "}",
    "console.error('unexpected npm command: ' + args.join(' '));",
    "process.exit(2);",
  ].join("\n");
  writeFileSync(join(bin, "npm"), fakeNpm);
  chmodSync(join(bin, "npm"), 0o755);
  return { root, bundle, bin, log, sri };
}

function run(data, scenario, extraArgs = []) {
  return spawnSync(
    process.execPath,
    [publishScript, data.bundle, ...extraArgs],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: data.bin + ":" + process.env.PATH,
        FAKE_NPM_LOG: data.log,
        FAKE_NPM_SCENARIO: scenario,
      },
    },
  );
}

test("dry-run validates bundle and invokes npm publish --dry-run without registry lookup", () => {
  const data = fixture();
  try {
    const result = run(data, "mismatch", ["--dry-run", "--tag", "preflight"]);
    assert.equal(result.status, 0, result.stderr);
    const lines = readFileSync(data.log, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^publish .*depatrol-0\.2\.0\.tgz --access public --tag preflight --dry-run$/);
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
});

test("publishes the exact attested tarball directly when registry returns E404", () => {
  const data = fixture();
  try {
    const result = run(data, "missing");
    assert.equal(result.status, 0, result.stderr);
    const lines = readFileSync(data.log, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^publish .*depatrol-0\.2\.0\.tgz --access public$/);
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
});

test("skips publish cleanly when existing registry SRI exactly matches tarball", () => {
  const data = fixture();
  try {
    const result = run(data, "match");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /registry integrity matches/);
    assert.equal(existsSync(data.log), false, "must not call npm publish");
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
});

test("fails closed before publishing when existing registry SRI differs", () => {
  const data = fixture();
  try {
    const result = run(data, "mismatch");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /registry integrity mismatch/);
    assert.equal(existsSync(data.log), false, "must not call npm publish");
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
});

test("fails closed on registry errors or outdated npm CLI", () => {
  const data = fixture();
  try {
    const errRes = run(data, "registry-error");
    assert.equal(errRes.status, 1);
    assert.match(errRes.stderr, /registry lookup failed/);
    assert.equal(existsSync(data.log), false);
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }

  const oldNpm = fixture({}, "11.5.0");
  try {
    const res = run(oldNpm, "missing");
    assert.equal(res.status, 1);
    assert.match(res.stderr, /OIDC trusted publishing needs >= 11\.5\.1/);
    assert.equal(existsSync(oldNpm.log), false);
  } finally {
    rmSync(oldNpm.root, { recursive: true, force: true });
  }
});

test("rejects a tarball with forbidden scripts or tampered bundle bytes", () => {
  const badPkg = fixture({ scripts: { postinstall: "echo bad" } });
  try {
    const res = run(badPkg, "missing");
    assert.equal(res.status, 1);
    assert.match(res.stderr, /lifecycle script is forbidden/);
    assert.equal(existsSync(badPkg.log), false);
  } finally {
    rmSync(badPkg.root, { recursive: true, force: true });
  }

  const tampered = fixture();
  try {
    const tgz = join(tampered.bundle, "depatrol-" + VERSION + ".tgz");
    const bytes = readFileSync(tgz);
    bytes[0] ^= 0xff;
    writeFileSync(tgz, bytes);
    const res = run(tampered, "missing");
    assert.equal(res.status, 1);
    assert.match(res.stderr, /digest mismatch/);
    assert.equal(existsSync(tampered.log), false);
  } finally {
    rmSync(tampered.root, { recursive: true, force: true });
  }
});
