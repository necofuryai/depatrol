#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TAG_PATTERN = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const REPOSITORY = "necofuryai/depatrol";
const SCHEMA_VERSION = 2;
const MANIFEST_NAME = "release-manifest.json";
const NOTES_NAME = "release-notes.md";
const CHECKSUMS_NAME = "checksums.txt";
const SRI_PATTERN = /^sha512-[A-Za-z0-9+/]+=*$/;

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

export function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function computeSri(path) {
  return "sha512-" + createHash("sha512").update(readFileSync(path)).digest("base64");
}

function fileRecord(path, includeSri = false) {
  const record = {
    name: basename(path),
    size: statSync(path).size,
    digest: "sha256:" + sha256(path),
  };
  if (includeSri) {
    record.integrity = computeSri(path);
  }
  return record;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function tarballName(version) {
  return "depatrol-" + version + ".tgz";
}

export function expectedAssetNames(version) {
  return [CHECKSUMS_NAME, tarballName(version)];
}

function sortedNames(entries) {
  return [...entries].sort((a, b) => a.localeCompare(b));
}

function assertSameNames(actual, expected, context) {
  const left = sortedNames(actual);
  const right = sortedNames(expected);
  invariant(
    JSON.stringify(left) === JSON.stringify(right),
    context + " names differ:\nactual: " + left.join(", ") + "\nexpected: " + right.join(", "),
  );
}

function verifyChecksums(bundleDir, version) {
  const checksumPath = join(bundleDir, CHECKSUMS_NAME);
  const tgzName = tarballName(version);
  const lines = readFileSync(checksumPath, "utf8").trim().split(/\r?\n/);
  const recorded = new Map();

  for (const line of lines) {
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    invariant(match, "invalid checksum line: " + line);
    invariant(!recorded.has(match[2]), "duplicate checksum entry: " + match[2]);
    recorded.set(match[2], match[1]);
  }

  assertSameNames(recorded.keys(), [tgzName], "checksum");
  invariant(
    recorded.get(tgzName) === sha256(join(bundleDir, tgzName)),
    "checksum mismatch for " + tgzName,
  );
}

export function createBundle(distDir, bundleDir, tag, commit, notesPath) {
  invariant(TAG_PATTERN.test(tag), "release tag must be exact SemVer: " + tag);
  invariant(/^[0-9a-f]{40}$/.test(commit), "release commit must be a full SHA");
  invariant(!existsSync(bundleDir), "refusing to overwrite existing bundle: " + bundleDir);

  const version = tag.slice(1);
  const tgzName = tarballName(version);
  const tarballSource = join(distDir, tgzName);
  invariant(existsSync(tarballSource), "missing npm tarball: " + tarballSource);
  invariant(existsSync(notesPath), "missing release notes: " + notesPath);

  mkdirSync(bundleDir, { recursive: false });
  const tarballDest = join(bundleDir, tgzName);
  copyFileSync(tarballSource, tarballDest);
  copyFileSync(notesPath, join(bundleDir, NOTES_NAME));

  const checksumLine = sha256(tarballDest) + "  " + tgzName + "\n";
  writeFileSync(join(bundleDir, CHECKSUMS_NAME), checksumLine);

  verifyChecksums(bundleDir, version);
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    repository: REPOSITORY,
    tag,
    commit,
    notes: fileRecord(join(bundleDir, NOTES_NAME)),
    assets: [
      fileRecord(join(bundleDir, CHECKSUMS_NAME)),
      fileRecord(tarballDest, true),
    ],
  };
  writeFileSync(
    join(bundleDir, MANIFEST_NAME),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  verifyBundle(bundleDir, tag, commit);
  return manifest;
}

export function verifyBundle(bundleDir, expectedTag, expectedCommit) {
  const manifest = readJson(join(bundleDir, MANIFEST_NAME));
  invariant(manifest.schemaVersion === SCHEMA_VERSION, "unsupported manifest schema");
  invariant(manifest.repository === REPOSITORY, "unexpected manifest repository");
  invariant(TAG_PATTERN.test(manifest.tag), "invalid manifest tag");
  invariant(/^[0-9a-f]{40}$/.test(manifest.commit), "invalid manifest commit");
  if (expectedTag) {
    invariant(manifest.tag === expectedTag, "manifest tag does not match workflow tag");
  }
  if (expectedCommit) {
    invariant(
      manifest.commit === expectedCommit,
      "manifest commit does not match workflow commit",
    );
  }

  const version = manifest.tag.slice(1);
  const tgzName = tarballName(version);
  assertSameNames(
    manifest.assets.map((asset) => asset.name),
    expectedAssetNames(version),
    "manifest asset",
  );
  invariant(manifest.notes.name === NOTES_NAME, "unexpected release notes name");

  const expectedFiles = [
    MANIFEST_NAME,
    NOTES_NAME,
    ...manifest.assets.map((asset) => asset.name),
  ];
  const entries = readdirSync(bundleDir);
  for (const name of entries) {
    invariant(
      statSync(join(bundleDir, name)).isFile(),
      "unexpected non-file entry in bundle: " + name,
    );
  }
  assertSameNames(entries, expectedFiles, "bundle file");

  for (const record of [manifest.notes, ...manifest.assets]) {
    const filePath = join(bundleDir, record.name);
    const actual = fileRecord(filePath, record.name === tgzName);
    invariant(actual.size === record.size, "size mismatch for " + record.name);
    invariant(actual.digest === record.digest, "digest mismatch for " + record.name);
    if (record.name === tgzName) {
      invariant(
        typeof record.integrity === "string" && SRI_PATTERN.test(record.integrity),
        "missing or invalid SRI integrity for " + record.name,
      );
      invariant(
        actual.integrity === record.integrity,
        "integrity mismatch for " + record.name,
      );
    }
  }
  verifyChecksums(bundleDir, version);
  return manifest;
}

export function verifyPublishedRelease(bundleDir, release, expectedDraft = false) {
  const manifest = verifyBundle(bundleDir);
  invariant(release.tag_name === manifest.tag, "published release tag mismatch");
  invariant(release.draft === expectedDraft, "release draft state mismatch");
  invariant(release.prerelease === false, "stable release marked as prerelease");

  const expected = [
    ...manifest.assets,
    fileRecord(join(bundleDir, MANIFEST_NAME)),
  ];
  const actual = release.assets.map((asset) => ({
    name: asset.name,
    size: asset.size,
    digest: asset.digest,
  }));
  assertSameNames(
    actual.map((asset) => asset.name),
    expected.map((asset) => asset.name),
    "published release asset",
  );
  const byName = new Map(actual.map((asset) => [asset.name, asset]));
  for (const record of expected) {
    const remote = byName.get(record.name);
    invariant(remote.size === record.size, "published size mismatch for " + record.name);
    invariant(
      remote.digest === record.digest,
      "published digest mismatch for " + record.name,
    );
  }
}

function usage() {
  console.error(
    "usage: artifacts.mjs create <dist> <bundle> <tag> <commit> <notes> | " +
      "verify <bundle> [tag] [commit] | " +
      "verify-release <bundle> <release-json> [draft|published]",
  );
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === "create" && args.length === 5) {
      createBundle(...args);
    } else if (command === "verify" && args.length >= 1 && args.length <= 3) {
      verifyBundle(...args);
    } else if (
      command === "verify-release" &&
      args.length >= 2 &&
      args.length <= 3
    ) {
      const expectedDraft = args[2] === "draft";
      invariant(
        !args[2] || args[2] === "draft" || args[2] === "published",
        "release state must be draft or published",
      );
      verifyPublishedRelease(args[0], readJson(args[1]), expectedDraft);
    } else {
      usage();
      process.exitCode = 2;
    }
  } catch (error) {
    console.error("artifacts: " + error.message);
    process.exitCode = 1;
  }
}
