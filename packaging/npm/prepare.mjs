#!/usr/bin/env node
// Repackage GoReleaser release archives into npm packages (ADR 0006:
// npm は GitHub Releases 成果物の再梱包)。 Stages everything under
// packaging/npm/dist/ for publish.mjs.
//
// Usage:
//   node packaging/npm/prepare.mjs <version> <artifact-dir>
//   node packaging/npm/prepare.mjs <version> --stub
//
// --stub builds binary-less platform packages. It is used exactly once,
// at bootstrap, to create the package names on the registry before
// trusted publishing can be registered (docs/runbooks/release.md).

import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// npm platform key -> GoReleaser {Os}_{Arch}. Keep in sync with the
// archives.name_template in .goreleaser.yaml.
const PLATFORMS = {
  "darwin-arm64": { goreleaser: "darwin_arm64", archive: "tar.gz", os: "darwin", cpu: "arm64" },
  "darwin-x64": { goreleaser: "darwin_amd64", archive: "tar.gz", os: "darwin", cpu: "x64" },
  "linux-arm64": { goreleaser: "linux_arm64", archive: "tar.gz", os: "linux", cpu: "arm64" },
  "linux-x64": { goreleaser: "linux_amd64", archive: "tar.gz", os: "linux", cpu: "x64" },
  "win32-x64": { goreleaser: "windows_amd64", archive: "zip", os: "win32", cpu: "x64" },
};

const SHARED_META = {
  license: "Apache-2.0",
  repository: {
    type: "git",
    url: "git+https://github.com/necofuryai/depatrol.git",
  },
  homepage: "https://github.com/necofuryai/depatrol#readme",
  bugs: "https://github.com/necofuryai/depatrol/issues",
};

function extractBinary(artifactDir, version, platform, binary, destDir) {
  const archive = join(
    artifactDir,
    `depatrol_${version}_${platform.goreleaser}.${platform.archive}`,
  );
  if (!existsSync(archive)) {
    console.error(`prepare: missing release archive ${archive}`);
    process.exit(1);
  }
  if (platform.archive === "zip") {
    execFileSync("unzip", ["-o", "-j", archive, binary, "-d", destDir], {
      stdio: "inherit",
    });
  } else {
    execFileSync("tar", ["-xzf", archive, "-C", destDir, binary], {
      stdio: "inherit",
    });
  }
}

const [version, artifactsArg] = process.argv.slice(2);
if (!version || !artifactsArg) {
  console.error("usage: prepare.mjs <version> <artifact-dir>|--stub");
  process.exit(2);
}
const stub = artifactsArg === "--stub";
const dist = join(here, "dist");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// Apache-2.0 §4(a): the license text must accompany the redistributed
// binary. npm includes a root-level LICENSE in the tarball regardless of
// the "files" array.
const license = join(here, "..", "..", "LICENSE");

for (const [key, platform] of Object.entries(PLATFORMS)) {
  const dir = join(dist, `cli-${key}`);
  mkdirSync(dir, { recursive: true });
  cpSync(license, join(dir, "LICENSE"));
  const binary = platform.os === "win32" ? "depatrol.exe" : "depatrol";
  const manifest = {
    name: `@depatrol/cli-${key}`,
    version,
    description: `The ${key} binary of depatrol`,
    ...SHARED_META,
    os: [platform.os],
    cpu: [platform.cpu],
    files: [binary],
  };
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  if (!stub) {
    extractBinary(artifactsArg, version, platform, binary, dir);
  }
}

const mainDir = join(dist, "depatrol");
cpSync(join(here, "depatrol"), mainDir, { recursive: true });
cpSync(license, join(mainDir, "LICENSE"));
const mainManifest = JSON.parse(
  readFileSync(join(mainDir, "package.json"), "utf8"),
);
delete mainManifest.private; // the template guard, not for the registry
mainManifest.version = version;
// Exact same-version pins — the release checklist depends on main and
// platform packages moving in lockstep (runbook: 同一バージョンに完全固定).
mainManifest.optionalDependencies = Object.fromEntries(
  Object.keys(PLATFORMS).map((key) => [`@depatrol/cli-${key}`, version]),
);
writeFileSync(
  join(mainDir, "package.json"),
  `${JSON.stringify(mainManifest, null, 2)}\n`,
);

console.log(`prepare: staged ${Object.keys(PLATFORMS).length + 1} packages at ${dist}`);
