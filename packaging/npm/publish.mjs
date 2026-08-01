#!/usr/bin/env node
// Idempotent npm publish for the packages staged by prepare.mjs.
// Platform packages go first so the main package never points at a
// version that is not yet installable (runbook: publish 順は platform →
// メイン). Versions already on the registry are skipped — that is what
// makes a same-tag job re-run repair a partial failure (ADR 0006 決定 3).
//
// Usage: node packaging/npm/publish.mjs <dist-dir> [--dry-run] [--tag <dist-tag>]

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const distDir = args[0];
const dryRun = args.includes("--dry-run");
const tagIndex = args.indexOf("--tag");
const distTag = tagIndex === -1 ? null : args[tagIndex + 1];

if (!distDir || distDir.startsWith("--") || (tagIndex !== -1 && !distTag)) {
  console.error("usage: publish.mjs <dist-dir> [--dry-run] [--tag <dist-tag>]");
  process.exit(2);
}

function assertNpmVersion() {
  const raw = execFileSync("npm", ["--version"], { encoding: "utf8" }).trim();
  const [major, minor, patch] = raw.split(".").map(Number);
  const ok =
    major > 11 || (major === 11 && (minor > 5 || (minor === 5 && patch >= 1)));
  if (!ok) {
    console.error(
      `publish: npm ${raw} is too old — OIDC trusted publishing needs >= 11.5.1`,
    );
    process.exit(1);
  }
}

function isPublished(name, version) {
  // npm 11 exits non-zero (E404) for a missing package and for a missing
  // version; older npm exited zero with empty output for the latter.
  // Either way, only "prints the version" counts as published — anything
  // else falls through to publishing, which is the safe direction.
  const result = spawnSync("npm", ["view", `${name}@${version}`, "version"], {
    encoding: "utf8",
  });
  return result.status === 0 && result.stdout.includes(version);
}

assertNpmVersion();

const staged = readdirSync(distDir)
  .filter((entry) => existsSync(join(distDir, entry, "package.json")))
  .sort((a, b) => {
    if (a === "depatrol") return 1; // main package last
    if (b === "depatrol") return -1;
    return a.localeCompare(b);
  });

if (staged.length === 0) {
  console.error(`publish: nothing staged in ${distDir} — run prepare.mjs first`);
  process.exit(1);
}

for (const entry of staged) {
  const dir = join(distDir, entry);
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const id = `${manifest.name}@${manifest.version}`;
  if (isPublished(manifest.name, manifest.version)) {
    console.log(`publish: skip ${id} (already on the registry)`);
    continue;
  }
  const publishArgs = ["publish", "--access", "public"];
  if (distTag) {
    publishArgs.push("--tag", distTag);
  }
  if (dryRun) {
    publishArgs.push("--dry-run");
  }
  console.log(`publish: ${id}${dryRun ? " (dry run)" : ""}`);
  execFileSync("npm", publishArgs, { cwd: dir, stdio: "inherit" });
}
