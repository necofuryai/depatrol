import assert from "node:assert/strict";
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
import { spawnSync } from "node:child_process";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const publishScript = resolve(here, "publish.mjs");
const entries = [
  ["cli-darwin-arm64", "@depatrol/cli-darwin-arm64"],
  ["cli-darwin-x64", "@depatrol/cli-darwin-x64"],
  ["cli-linux-arm64", "@depatrol/cli-linux-arm64"],
  ["cli-linux-x64", "@depatrol/cli-linux-x64"],
  ["cli-win32-x64", "@depatrol/cli-win32-x64"],
  ["depatrol", "depatrol"],
];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "depatrol-publish-test-"));
  const dist = join(root, "dist");
  const bin = join(root, "bin");
  const log = join(root, "npm.log");
  mkdirSync(dist);
  mkdirSync(bin);
  for (const [entry, name] of entries) {
    const dir = join(dist, entry);
    mkdirSync(dir);
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name, version: "1.2.3" }),
    );
  }

  const fakeNpm = [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const args = process.argv.slice(2);",
    "if (args[0] === '--version') { console.log('11.19.0'); process.exit(0); }",
    "if (args[0] === 'pack') {",
    "  const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json')));",
    "  const dest = args[args.indexOf('--pack-destination') + 1];",
    "  const filename = manifest.name.replace('@', '').replace('/', '-') + '-1.2.3.tgz';",
    "  fs.writeFileSync(path.join(dest, filename), manifest.name);",
    "  console.log(JSON.stringify([{ filename, integrity: 'sha512-' + manifest.name }]));",
    "  process.exit(0);",
    "}",
    "if (args[0] === 'view') {",
    "  const id = args[1];",
    "  const name = id.slice(0, id.lastIndexOf('@'));",
    "  if (process.env.FAKE_NPM_SCENARIO === 'missing') { console.error('E404'); process.exit(1); }",
    "  if (process.env.FAKE_NPM_SCENARIO === 'late-mismatch' && name === '@depatrol/cli-darwin-arm64') { console.error('E404'); process.exit(1); }",
    "  if (process.env.FAKE_NPM_SCENARIO === 'late-mismatch' && name === '@depatrol/cli-darwin-x64') { console.log(JSON.stringify('sha512-mismatch')); process.exit(0); }",
    "  if (process.env.FAKE_NPM_SCENARIO === 'mismatch') { console.log(JSON.stringify('sha512-mismatch')); process.exit(0); }",
    "  console.log(JSON.stringify('sha512-' + name));",
    "  process.exit(0);",
    "}",
    "if (args[0] === 'publish') {",
    "  fs.appendFileSync(process.env.FAKE_NPM_LOG, path.basename(args[1]) + '\\n');",
    "  process.exit(0);",
    "}",
    "console.error('unexpected npm command: ' + args.join(' '));",
    "process.exit(2);",
  ].join("\n");
  writeFileSync(join(bin, "npm"), fakeNpm);
  chmodSync(join(bin, "npm"), 0o755);
  return { root, dist, bin, log };
}

function run(data, scenario, extraArgs = []) {
  return spawnSync(
    process.execPath,
    [publishScript, data.dist, ...extraArgs],
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

test("dry-run validates all packages in platform-first order without registry lookup", () => {
  const data = fixture();
  try {
    const result = run(data, "mismatch", ["--dry-run", "--tag", "preflight"]);
    assert.equal(result.status, 0, result.stderr);
    const published = readFileSync(data.log, "utf8").trim().split("\n");
    assert.equal(published.length, 6);
    assert.match(published[0], /cli-darwin-arm64/);
    assert.match(published[5], /^depatrol-1\.2\.3/);
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
});

test("skips only when every registry integrity matches", () => {
  const data = fixture();
  try {
    const result = run(data, "match");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.match(/registry integrity matches/g)?.length, 6);
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
});

test("fails before publishing when an existing version has different bytes", () => {
  const data = fixture();
  try {
    const result = run(data, "mismatch");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /registry integrity mismatch/);
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
});

test("validates every registry version before the first publish", () => {
  const data = fixture();
  try {
    const result = run(data, "late-mismatch");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /registry integrity mismatch/);
    assert.equal(existsSync(data.log), false, "no package may be published");
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
});
