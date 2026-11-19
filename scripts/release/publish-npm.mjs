#!/usr/bin/env node
// Publish the single verified npm tarball from the attested release bundle
// (ADR 0009). Never re-packs at publish time.
//
// A same-version retry is skipped only when the registry SRI exactly matches
// the tarball in the release bundle; a mismatch fails closed and requires a
// new patch release.
//
// Usage: node scripts/release/publish-npm.mjs <bundle-dir> [--dry-run] [--tag <dist-tag>]

import { execFileSync, spawnSync } from "node:child_process";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { computeSri, tarballName, verifyBundle } from "./artifacts.mjs";
import { validatePublishedManifest } from "./build-package.mjs";

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

export function assertNpmVersion() {
  const raw = execFileSync("npm", ["--version"], { encoding: "utf8" }).trim();
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(raw);
  invariant(match, "unexpected npm version output: " + raw);
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  const ok =
    major > 11 || (major === 11 && (minor > 5 || (minor === 5 && patch >= 1)));
  if (!ok) {
    throw new Error(
      "npm " + raw + " is too old; OIDC trusted publishing needs >= 11.5.1",
    );
  }
}

export function inspectTarballManifest(tarballPath, expectedVersion) {
  const raw = execFileSync("tar", ["-xOf", tarballPath, "package/package.json"], {
    encoding: "utf8",
  });
  const manifest = JSON.parse(raw);
  validatePublishedManifest(manifest, expectedVersion);
  return manifest;
}

export function publishedIntegrity(name, version) {
  const result = spawnSync(
    "npm",
    ["view", name + "@" + version, "dist.integrity", "--json"],
    { encoding: "utf8" },
  );
  if (result.status === 0) {
    const value = JSON.parse(result.stdout);
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(
        "registry returned an invalid integrity for " + name + "@" + version,
      );
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

export function publishBundle(bundleDir, { dryRun = false, distTag = null } = {}) {
  assertNpmVersion();

  const resolvedBundle = isAbsolute(bundleDir)
    ? bundleDir
    : join(process.cwd(), bundleDir);
  const manifest = verifyBundle(resolvedBundle);
  const version = manifest.tag.slice(1);
  const expectedFilename = tarballName(version);
  const tarballRecord = manifest.assets.find(
    (asset) => asset.name === expectedFilename,
  );
  invariant(tarballRecord, "manifest is missing tarball asset: " + expectedFilename);

  const tarballPath = join(resolvedBundle, expectedFilename);
  const localIntegrity = computeSri(tarballPath);
  invariant(
    localIntegrity === tarballRecord.integrity,
    "tarball SRI does not match release manifest",
  );

  const pkg = inspectTarballManifest(tarballPath, version);
  const id = pkg.name + "@" + pkg.version;

  if (!dryRun) {
    const remote = publishedIntegrity(pkg.name, pkg.version);
    if (remote === localIntegrity) {
      console.log("publish: skip " + id + " (registry integrity matches)");
      return { id, published: false, skipped: true, integrity: localIntegrity };
    }
    if (remote !== null) {
      throw new Error(
        "registry integrity mismatch for " +
          id +
          "; do not replace the version, create a patch release",
      );
    }
  }

  const publishArgs = ["publish", tarballPath, "--access", "public"];
  if (distTag) {
    publishArgs.push("--tag", distTag);
  }
  if (dryRun) {
    publishArgs.push("--dry-run");
  }
  console.log("publish: " + id + (dryRun ? " (dry run)" : ""));
  execFileSync("npm", publishArgs, { stdio: "inherit" });
  return { id, published: true, skipped: false, integrity: localIntegrity };
}

function parseCliArgs(argv) {
  const bundleDir = argv[0];
  let dryRun = false;
  let distTag = null;

  if (!bundleDir || bundleDir.startsWith("--")) {
    return null;
  }
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--tag") {
      distTag = argv[i + 1] ?? null;
      if (!distTag || distTag.startsWith("--")) {
        return null;
      }
      i += 1;
    } else {
      return null;
    }
  }
  return { bundleDir, dryRun, distTag };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (!parsed) {
    console.error("usage: publish-npm.mjs <bundle-dir> [--dry-run] [--tag <dist-tag>]");
    process.exit(2);
  }
  try {
    publishBundle(parsed.bundleDir, {
      dryRun: parsed.dryRun,
      distTag: parsed.distTag,
    });
  } catch (error) {
    console.error("publish: " + error.message);
    process.exitCode = 1;
  }
}
