#!/usr/bin/env node
// Pack and publish the packages staged by prepare.mjs.
//
// All six tarballs are created before the first registry write. Platform
// packages are published first and the main package last. A same-version
// retry is skipped only when the registry SRI exactly matches the tarball
// built by this run; a mismatch requires a new patch release.
//
// Usage: node packaging/npm/publish.mjs <dist-dir> [--dry-run] [--tag <dist-tag>]

import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

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
    throw new Error(
      "npm " + raw + " is too old; OIDC trusted publishing needs >= 11.5.1",
    );
  }
}

function publishedIntegrity(name, version) {
  const result = spawnSync(
    "npm",
    ["view", name + "@" + version, "dist.integrity", "--json"],
    { encoding: "utf8" },
  );
  if (result.status === 0) {
    const value = JSON.parse(result.stdout);
    if (typeof value !== "string" || value.length === 0) {
      throw new Error("registry returned an invalid integrity for " + name + "@" + version);
    }
    return value;
  }
  if ((result.stderr || "").includes("E404")) {
    return null;
  }
  throw new Error(
    "registry lookup failed for " +
      name +
      "@" +
      version +
      ":\n" +
      (result.stderr || result.stdout),
  );
}

function packPackage(dir, packDir) {
  const output = execFileSync(
    "npm",
    ["pack", "--json", "--pack-destination", packDir],
    { cwd: dir, encoding: "utf8" },
  );
  const records = JSON.parse(output);
  if (!Array.isArray(records) || records.length !== 1) {
    throw new Error("npm pack returned an unexpected result for " + dir);
  }
  const record = records[0];
  if (!record.filename || !record.integrity) {
    throw new Error("npm pack omitted filename or integrity for " + dir);
  }
  return {
    tarball: join(packDir, record.filename),
    integrity: record.integrity,
  };
}

function stagedPackages(root) {
  return readdirSync(root)
    .filter((entry) => existsSync(join(root, entry, "package.json")))
    .sort((a, b) => {
      if (a === "depatrol") return 1;
      if (b === "depatrol") return -1;
      return a.localeCompare(b);
    });
}

assertNpmVersion();

const resolvedDist = isAbsolute(distDir) ? distDir : join(process.cwd(), distDir);
const staged = stagedPackages(resolvedDist);
if (staged.length !== 6 || staged.at(-1) !== "depatrol") {
  console.error("publish: expected five platform packages followed by depatrol");
  process.exit(1);
}

const packDir = mkdtempSync(join(tmpdir(), "depatrol-npm-pack-"));
try {
  const packed = staged.map((entry) => {
    const dir = join(resolvedDist, entry);
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const archive = packPackage(dir, packDir);
    return {
      id: manifest.name + "@" + manifest.version,
      name: manifest.name,
      version: manifest.version,
      ...archive,
    };
  });

  const decisions = packed.map((item) => {
    if (dryRun) {
      return { item, publish: true };
    }

    const remote = publishedIntegrity(item.name, item.version);
    if (remote === item.integrity) {
      return { item, publish: false };
    }
    if (remote !== null) {
      throw new Error(
        "registry integrity mismatch for " +
          item.id +
          "; do not replace the version, create a patch release",
      );
    }
    return { item, publish: true };
  });

  for (const decision of decisions) {
    const { item } = decision;
    if (!decision.publish) {
      console.log("publish: skip " + item.id + " (registry integrity matches)");
      continue;
    }

    const publishArgs = ["publish", item.tarball, "--access", "public"];
    if (distTag) {
      publishArgs.push("--tag", distTag);
    }
    if (dryRun) {
      publishArgs.push("--dry-run");
    }
    console.log("publish: " + item.id + (dryRun ? " (dry run)" : ""));
    execFileSync("npm", publishArgs, { stdio: "inherit" });
  }
} catch (error) {
  console.error("publish: " + error.message);
  process.exitCode = 1;
} finally {
  rmSync(packDir, { recursive: true, force: true });
}
