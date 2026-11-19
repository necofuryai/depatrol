#!/usr/bin/env node
// Build the single Node.js 22+ / Bun compatible bundle and pack the single
// npm tarball (ADR 0009). Also exposes manifest and bundle verification modes
// used by scripts/ci/verify.sh.
//
// Usage:
//   node scripts/release/build-package.mjs <version> <commit> <commit-date> <out-dir>
//   node scripts/release/build-package.mjs --check-manifest [repo-root]
//   node scripts/release/build-package.mjs --check-bundle <bundle-js-path>

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
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

import { computeSri, sha256, tarballName } from "./artifacts.mjs";

const VERSION_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const SHEBANG = "#!/usr/bin/env node\n";
const MIN_NODE_MAJOR = 22;

export const LIFECYCLE_SCRIPTS = new Set([
  "preinstall",
  "install",
  "postinstall",
  "preuninstall",
  "uninstall",
  "postuninstall",
  "prepare",
  "prepublish",
  "prepublishOnly",
  "publish",
  "postpublish",
  "prepack",
  "postpack",
]);

export const EXPECTED_MANIFEST_FILES = [
  "LICENSE",
  "README.md",
  "dist/depatrol.js",
];

export const ALLOWED_TARBALL_FILES = [
  "LICENSE",
  "README.md",
  "dist/depatrol.js",
  "package.json",
];

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function sortedNames(entries) {
  return [...entries].sort((a, b) => a.localeCompare(b));
}

function assertEmptyMap(obj, label) {
  if (obj === undefined) {
    return;
  }
  invariant(
    obj !== null && typeof obj === "object" && !Array.isArray(obj),
    label + " must be an object when present",
  );
  invariant(
    Object.keys(obj).length === 0,
    label + " must be empty (found: " + Object.keys(obj).join(", ") + ")",
  );
}

export function validateNodeEngineFloor(engines) {
  const floor = engines?.node ?? "";
  invariant(
    /^>=\d+$/.test(floor),
    "engines.node must be a bare major floor (e.g. >=22), got: " + JSON.stringify(floor),
  );
  const major = Number(floor.slice(2));
  invariant(
    major >= MIN_NODE_MAJOR,
    `engines.node floor ${floor} is below Node ${MIN_NODE_MAJOR}`,
  );
}

export function validateRootManifest(manifest) {
  invariant(manifest && typeof manifest === "object", "package.json must be an object");
  invariant(manifest.name === "depatrol", "package.json name must be depatrol");
  invariant(manifest.license === "Apache-2.0", "package.json license must be Apache-2.0");
  invariant(manifest.type === "module", 'package.json type must be "module"');
  invariant(
    manifest.bin?.depatrol === "./dist/depatrol.js",
    'package.json bin.depatrol must be "./dist/depatrol.js"',
  );

  invariant(Array.isArray(manifest.files), "package.json files must be an array");
  const actualFiles = sortedNames(manifest.files);
  const expectedFiles = sortedNames(EXPECTED_MANIFEST_FILES);
  invariant(
    JSON.stringify(actualFiles) === JSON.stringify(expectedFiles),
    "package.json files mismatch:\nactual: " +
      actualFiles.join(", ") +
      "\nexpected: " +
      expectedFiles.join(", "),
  );

  validateNodeEngineFloor(manifest.engines);
  assertEmptyMap(manifest.dependencies, "dependencies");
  assertEmptyMap(manifest.optionalDependencies, "optionalDependencies");
  assertEmptyMap(manifest.peerDependencies, "peerDependencies");

  if (manifest.scripts !== undefined) {
    invariant(
      manifest.scripts !== null && typeof manifest.scripts === "object",
      "scripts must be an object",
    );
    for (const key of Object.keys(manifest.scripts)) {
      invariant(
        !LIFECYCLE_SCRIPTS.has(key),
        "lifecycle script is forbidden (ADR 0009): " + key,
      );
    }
  }
}

export function validatePublishedManifest(manifest, expectedVersion) {
  validateRootManifest(manifest);
  invariant(manifest.private === undefined, "published package.json must not set private");
  invariant(manifest.version === expectedVersion, "published package.json version mismatch");
  invariant(manifest.scripts === undefined, "published package.json must omit scripts");
  invariant(
    manifest.devDependencies === undefined,
    "published package.json must omit devDependencies",
  );
  invariant(
    manifest.dependencies === undefined,
    "published package.json must omit dependencies",
  );
  invariant(
    manifest.optionalDependencies === undefined,
    "published package.json must omit optionalDependencies",
  );
  invariant(
    manifest.peerDependencies === undefined,
    "published package.json must omit peerDependencies",
  );
}

export function createPublishManifest(rootManifest, version) {
  validateRootManifest(rootManifest);
  invariant(VERSION_PATTERN.test(version), "release version must be exact SemVer: " + version);

  const published = {
    name: rootManifest.name,
    version,
    description: rootManifest.description,
    keywords: rootManifest.keywords,
    license: rootManifest.license,
    repository: rootManifest.repository,
    homepage: rootManifest.homepage,
    bugs: rootManifest.bugs,
    type: rootManifest.type,
    bin: { depatrol: rootManifest.bin.depatrol },
    files: [...rootManifest.files],
    engines: { node: rootManifest.engines.node },
  };
  validatePublishedManifest(published, version);
  return published;
}

export function assertNodeCompatibleBundle(source) {
  invariant(typeof source === "string" && source.length > 0, "bundle must be non-empty");
  invariant(
    source.startsWith(SHEBANG),
    "bundle must start with #!/usr/bin/env node",
  );
  const afterShebang = source.slice(SHEBANG.length);
  invariant(!afterShebang.startsWith("#!"), "bundle must not contain duplicate shebang");
  invariant(!/\bBun\./.test(source), "bundle references Bun.* runtime API");
  invariant(
    !/["'`]bun:[^"'`]+["'`]/.test(source),
    "bundle references bun:* built-in module",
  );
}

export function checkRepositoryManifest(repoRoot) {
  const pkgPath = join(repoRoot, "package.json");
  const lockPath = join(repoRoot, "bun.lock");
  invariant(existsSync(pkgPath), "missing package.json at " + pkgPath);
  invariant(existsSync(lockPath), "missing bun.lock at " + lockPath);
  const manifest = JSON.parse(readFileSync(pkgPath, "utf8"));
  validateRootManifest(manifest);
  return manifest;
}

export function buildPackage({ repoRoot, version, commit, commitDate, outDir }) {
  invariant(VERSION_PATTERN.test(version), "version must be exact SemVer: " + version);
  invariant(COMMIT_PATTERN.test(commit), "commit must be a 40-char lowercase SHA");
  invariant(
    ISO_DATE_PATTERN.test(commitDate),
    "commitDate must be an ISO-8601 timestamp: " + commitDate,
  );

  const rootManifest = checkRepositoryManifest(repoRoot);
  const publishedManifest = createPublishManifest(rootManifest, version);

  const entryPath = join(repoRoot, "src", "index.ts");
  const licensePath = join(repoRoot, "LICENSE");
  const readmePath = join(repoRoot, "README.md");
  invariant(existsSync(entryPath), "missing entrypoint: " + entryPath);
  invariant(existsSync(licensePath), "missing LICENSE: " + licensePath);
  invariant(existsSync(readmePath), "missing README.md: " + readmePath);

  const workRoot = mkdtempSync(join(tmpdir(), "depatrol-build-pkg-"));
  const stageDir = join(workRoot, "stage");
  const verifyDir = join(workRoot, "verify");
  try {
    mkdirSync(join(stageDir, "dist"), { recursive: true });
    mkdirSync(verifyDir, { recursive: true });
    mkdirSync(outDir, { recursive: true });

    const bundlePath = join(stageDir, "dist", "depatrol.js");
    execFileSync(
      "bun",
      [
        "build",
        entryPath,
        "--outfile",
        bundlePath,
        "--target",
        "node",
        "--format",
        "esm",
        "--banner",
        "#!/usr/bin/env node",
        "--define",
        "__DEPATROL_VERSION__=" + JSON.stringify(version),
        "--define",
        "__DEPATROL_COMMIT__=" + JSON.stringify(commit),
        "--define",
        "__DEPATROL_DATE__=" + JSON.stringify(commitDate),
      ],
      { cwd: repoRoot, stdio: "inherit" },
    );
    chmodSync(bundlePath, 0o755);
    assertNodeCompatibleBundle(readFileSync(bundlePath, "utf8"));

    writeFileSync(
      join(stageDir, "package.json"),
      JSON.stringify(publishedManifest, null, 2) + "\n",
    );
    copyFileSync(licensePath, join(stageDir, "LICENSE"));
    copyFileSync(readmePath, join(stageDir, "README.md"));

    const packOutput = execFileSync(
      "npm",
      ["pack", "--json", "--pack-destination", resolve(outDir)],
      { cwd: stageDir, encoding: "utf8" },
    );
    const records = JSON.parse(packOutput);
    invariant(
      Array.isArray(records) && records.length === 1,
      "npm pack returned an unexpected result",
    );
    const record = records[0];
    const expectedFilename = tarballName(version);
    invariant(
      record.filename === expectedFilename,
      `unexpected tarball name: ${record.filename} (expected ${expectedFilename})`,
    );
    invariant(Array.isArray(record.files), "npm pack omitted file listing");
    const packedFiles = sortedNames(record.files.map((entry) => entry.path));
    invariant(
      JSON.stringify(packedFiles) === JSON.stringify(sortedNames(ALLOWED_TARBALL_FILES)),
      "tarball files mismatch:\nactual: " +
        packedFiles.join(", ") +
        "\nexpected: " +
        ALLOWED_TARBALL_FILES.join(", "),
    );

    const tarballPath = join(resolve(outDir), expectedFilename);
    const actualSri = computeSri(tarballPath);
    invariant(
      record.integrity === actualSri,
      "npm pack integrity mismatch against tarball bytes",
    );

    execFileSync("tar", ["-xzf", tarballPath, "-C", verifyDir], {
      stdio: "inherit",
    });
    const unpackedDir = join(verifyDir, "package");
    const unpackedManifest = JSON.parse(
      readFileSync(join(unpackedDir, "package.json"), "utf8"),
    );
    validatePublishedManifest(unpackedManifest, version);

    const unpackedBin = join(unpackedDir, "dist", "depatrol.js");
    assertNodeCompatibleBundle(readFileSync(unpackedBin, "utf8"));

    const expectedVersionLine = `depatrol version ${version} (commit ${commit}, commit date ${commitDate})\n`;
    const nodeOut = execFileSync("node", [unpackedBin, "--version"], {
      encoding: "utf8",
    });
    const bunOut = execFileSync("bun", [unpackedBin, "--version"], {
      encoding: "utf8",
    });
    invariant(
      nodeOut === expectedVersionLine,
      `unexpected node --version output: ${JSON.stringify(nodeOut)}`,
    );
    invariant(
      bunOut === expectedVersionLine,
      `unexpected bun --version output: ${JSON.stringify(bunOut)}`,
    );

    return {
      filename: expectedFilename,
      tarballPath,
      integrity: actualSri,
      digest: "sha256:" + sha256(tarballPath),
    };
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
}

function usage() {
  console.error(
    "usage: build-package.mjs <version> <commit> <commit-date> <out-dir> | " +
      "--check-manifest [repo-root] | --check-bundle <bundle-js-path>",
  );
}

const here = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(here, "../..");
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  try {
    if (args[0] === "--check-manifest" && args.length <= 2) {
      checkRepositoryManifest(args[1] ? resolve(args[1]) : defaultRepoRoot);
    } else if (args[0] === "--check-bundle" && args.length === 2) {
      assertNodeCompatibleBundle(readFileSync(args[1], "utf8"));
    } else if (args.length === 4 && !args[0].startsWith("--")) {
      const [version, commit, commitDate, outDir] = args;
      const result = buildPackage({
        repoRoot: defaultRepoRoot,
        version,
        commit,
        commitDate,
        outDir,
      });
      console.log(`build-package: packed ${result.filename} (${result.integrity})`);
    } else {
      usage();
      process.exitCode = 2;
    }
  } catch (error) {
    console.error("build-package: " + error.message);
    process.exitCode = 1;
  }
}
