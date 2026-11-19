import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
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

import {
  assertNodeCompatibleBundle,
  createPublishManifest,
  validateRootManifest,
} from "./build-package.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const buildScript = resolve(here, "build-package.mjs");

function baseRootManifest() {
  return {
    name: "depatrol",
    version: "0.2.0",
    private: true,
    description: "Read-only control plane for Dependabot across GitHub repositories",
    keywords: ["dependabot", "cli"],
    license: "Apache-2.0",
    repository: {
      type: "git",
      url: "git+https://github.com/necofuryai/depatrol.git",
    },
    homepage: "https://github.com/necofuryai/depatrol#readme",
    bugs: "https://github.com/necofuryai/depatrol/issues",
    type: "module",
    bin: { depatrol: "./dist/depatrol.js" },
    files: ["dist/depatrol.js", "LICENSE", "README.md"],
    engines: { node: ">=22" },
    scripts: {
      build: "bun build src/index.ts --outfile dist/depatrol.js --target node --format esm",
      typecheck: "tsc --noEmit",
      test: "bun test",
    },
    devDependencies: {
      typescript: "^7.0.2",
      yaml: "^2.9.1",
    },
  };
}

test("creates a stripped publish manifest with version injected and Node >= 22 floor", () => {
  const published = createPublishManifest(baseRootManifest(), "0.2.1");
  assert.equal(published.name, "depatrol");
  assert.equal(published.version, "0.2.1");
  assert.equal(published.private, undefined);
  assert.equal(published.scripts, undefined);
  assert.equal(published.devDependencies, undefined);
  assert.equal(published.dependencies, undefined);
  assert.equal(published.optionalDependencies, undefined);
  assert.deepEqual(published.engines, { node: ">=22" });
  assert.deepEqual(published.bin, { depatrol: "./dist/depatrol.js" });
});

test("rejects lifecycle scripts, runtime dependencies, optionalDependencies, and low Node floor", () => {
  assert.throws(
    () =>
      validateRootManifest({
        ...baseRootManifest(),
        scripts: { ...baseRootManifest().scripts, postinstall: "echo nope" },
      }),
    /lifecycle script is forbidden/,
  );

  assert.throws(
    () =>
      validateRootManifest({
        ...baseRootManifest(),
        dependencies: { yaml: "^2.9.1" },
      }),
    /dependencies must be empty/,
  );

  assert.throws(
    () =>
      validateRootManifest({
        ...baseRootManifest(),
        optionalDependencies: { "@depatrol/cli-darwin-arm64": "0.1.6" },
      }),
    /optionalDependencies must be empty/,
  );

  assert.throws(
    () =>
      validateRootManifest({
        ...baseRootManifest(),
        engines: { node: ">=20" },
      }),
    /below Node 22/,
  );

  assert.throws(
    () =>
      validateRootManifest({
        ...baseRootManifest(),
        engines: { node: ">=22.0.0" },
      }),
    /bare major floor/,
  );
});

test("assertNodeCompatibleBundle enforces shebang and rejects Bun runtime references", () => {
  assert.doesNotThrow(() =>
    assertNodeCompatibleBundle("#!/usr/bin/env node\nconsole.log('ok');\n"),
  );

  assert.throws(
    () => assertNodeCompatibleBundle("console.log('no shebang');\n"),
    /must start with #!\/usr\/bin\/env node/,
  );

  assert.throws(
    () =>
      assertNodeCompatibleBundle(
        "#!/usr/bin/env node\n#!/usr/bin/env node\nconsole.log('dup');\n",
      ),
    /duplicate shebang/,
  );

  assert.throws(
    () =>
      assertNodeCompatibleBundle(
        "#!/usr/bin/env node\nconst x = Bun.file('a');\n",
      ),
    /Bun\.\* runtime API/,
  );

  assert.throws(
    () =>
      assertNodeCompatibleBundle(
        "#!/usr/bin/env node\nimport { Database } from 'bun:sqlite';\n",
      ),
    /bun:\* built-in module/,
  );
});

test("repository root package.json passes --check-manifest", () => {
  const result = spawnSync(process.execPath, [buildScript, "--check-manifest"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
});

test("buildPackage packs a clean tarball and verifies Node + Bun execution", () => {
  const root = mkdtempSync(join(tmpdir(), "depatrol-build-pkg-test-"));
  const repo = join(root, "repo");
  const outDir = join(root, "out");
  const binDir = join(root, "bin");
  try {
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(repo, "package.json"), JSON.stringify(baseRootManifest(), null, 2));
    writeFileSync(join(repo, "bun.lock"), "{}\n");
    writeFileSync(join(repo, "LICENSE"), "Apache-2.0\n");
    writeFileSync(join(repo, "README.md"), "# depatrol\n");
    writeFileSync(join(repo, "src", "index.ts"), "// placeholder\n");

    const fakeBun = [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const { spawnSync } = require('node:child_process');",
      "const args = process.argv.slice(2);",
      "if (args[0] === 'build') {",
      "  const out = args[args.indexOf('--outfile') + 1];",
      "  const banner = args[args.indexOf('--banner') + 1];",
      "  const defines = {};",
      "  for (let i = 0; i < args.length; i++) {",
      "    if (args[i] === '--define') {",
      "      const eq = args[i + 1].indexOf('=');",
      "      defines[args[i + 1].slice(0, eq)] = JSON.parse(args[i + 1].slice(eq + 1));",
      "    }",
      "  }",
      "  const body = `${banner}\\nconst v = ${JSON.stringify(defines.__DEPATROL_VERSION__)};\\nconst c = ${JSON.stringify(defines.__DEPATROL_COMMIT__)};\\nconst d = ${JSON.stringify(defines.__DEPATROL_DATE__)};\\nconsole.log('depatrol version ' + v + ' (commit ' + c + ', commit date ' + d + ')');\\n`;",
      "  fs.mkdirSync(path.dirname(out), { recursive: true });",
      "  fs.writeFileSync(out, body);",
      "  process.exit(0);",
      "}",
      "const res = spawnSync(process.execPath, args, { stdio: 'inherit' });",
      "process.exit(res.status ?? 1);",
    ].join("\n");
    writeFileSync(join(binDir, "bun"), fakeBun);
    chmodSync(join(binDir, "bun"), 0o755);

    const fakeNpm = [
      "#!/usr/bin/env node",
      "const crypto = require('node:crypto');",
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const { execFileSync } = require('node:child_process');",
      "const args = process.argv.slice(2);",
      "if (args[0] !== 'pack') process.exit(2);",
      "const dest = args[args.indexOf('--pack-destination') + 1];",
      "const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));",
      "const filename = `${pkg.name}-${pkg.version}.tgz`;",
      "const tmp = fs.mkdtempSync(path.join(dest, 'tar-stage-'));",
      "const pkgDir = path.join(tmp, 'package');",
      "fs.cpSync(process.cwd(), pkgDir, { recursive: true });",
      "const outFile = path.join(dest, filename);",
      "execFileSync('tar', ['-czf', outFile, '-C', tmp, 'package']);",
      "fs.rmSync(tmp, { recursive: true, force: true });",
      "const integrity = 'sha512-' + crypto.createHash('sha512').update(fs.readFileSync(outFile)).digest('base64');",
      "console.log(JSON.stringify([{ filename, integrity, files: [{ path: 'LICENSE' }, { path: 'README.md' }, { path: 'dist/depatrol.js' }, { path: 'package.json' }] }]));",
    ].join("\n");
    writeFileSync(join(binDir, "npm"), fakeNpm);
    chmodSync(join(binDir, "npm"), 0o755);

    const commit = "0123456789abcdef0123456789abcdef01234567";
    const commitDate = "2026-11-19T11:00:00Z";
    const runner = `
      import { buildPackage } from ${JSON.stringify(buildScript)};
      const res = buildPackage({
        repoRoot: ${JSON.stringify(repo)},
        version: "0.2.0",
        commit: ${JSON.stringify(commit)},
        commitDate: ${JSON.stringify(commitDate)},
        outDir: ${JSON.stringify(outDir)},
      });
      console.log(JSON.stringify(res));
    `;
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", runner], {
      encoding: "utf8",
      env: { ...process.env, PATH: binDir + ":" + process.env.PATH },
    });
    const result = JSON.parse(output.trim());
    assert.equal(result.filename, "depatrol-0.2.0.tgz");
    assert.match(result.integrity, /^sha512-/);
    assert.match(result.digest, /^sha256:[0-9a-f]{64}$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
