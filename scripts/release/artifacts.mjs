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
const MANIFEST_NAME = "release-manifest.json";
const NOTES_NAME = "release-notes.md";

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fileRecord(path) {
  return {
    name: basename(path),
    size: statSync(path).size,
    digest: "sha256:" + sha256(path),
  };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function expectedAssetNames(version) {
  return [
    "depatrol_" + version + "_checksums.txt",
    "depatrol_" + version + "_darwin_amd64.tar.gz",
    "depatrol_" + version + "_darwin_arm64.tar.gz",
    "depatrol_" + version + "_linux_amd64.tar.gz",
    "depatrol_" + version + "_linux_arm64.tar.gz",
    "depatrol_" + version + "_windows_amd64.zip",
  ];
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
  const checksumName = "depatrol_" + version + "_checksums.txt";
  const checksumPath = join(bundleDir, checksumName);
  const archiveNames = expectedAssetNames(version).filter((name) => name !== checksumName);
  const lines = readFileSync(checksumPath, "utf8").trim().split(/\r?\n/);
  const recorded = new Map();

  for (const line of lines) {
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    invariant(match, "invalid checksum line: " + line);
    recorded.set(match[2], match[1]);
  }

  assertSameNames(recorded.keys(), archiveNames, "checksum");
  for (const name of archiveNames) {
    invariant(
      recorded.get(name) === sha256(join(bundleDir, name)),
      "checksum mismatch for " + name,
    );
  }
}

export function createBundle(distDir, bundleDir, tag, commit, notesPath) {
  invariant(TAG_PATTERN.test(tag), "release tag must be exact SemVer: " + tag);
  invariant(/^[0-9a-f]{40}$/.test(commit), "release commit must be a full SHA");
  invariant(!existsSync(bundleDir), "refusing to overwrite existing bundle: " + bundleDir);

  const version = tag.slice(1);
  const metadata = readJson(join(distDir, "metadata.json"));
  invariant(metadata.project_name === "depatrol", "unexpected GoReleaser project");
  invariant(metadata.version === version, "GoReleaser version does not match tag");
  invariant(metadata.commit === commit, "GoReleaser commit does not match tag commit");

  mkdirSync(bundleDir, { recursive: false });
  const assetNames = expectedAssetNames(version);
  for (const name of assetNames) {
    const source = join(distDir, name);
    invariant(existsSync(source), "missing GoReleaser asset: " + source);
    copyFileSync(source, join(bundleDir, name));
  }
  invariant(existsSync(notesPath), "missing release notes: " + notesPath);
  copyFileSync(notesPath, join(bundleDir, NOTES_NAME));

  verifyChecksums(bundleDir, version);
  const manifest = {
    schemaVersion: 1,
    repository: REPOSITORY,
    tag,
    commit,
    notes: fileRecord(join(bundleDir, NOTES_NAME)),
    assets: assetNames.map((name) => fileRecord(join(bundleDir, name))),
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
  invariant(manifest.schemaVersion === 1, "unsupported manifest schema");
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
  const actualFiles = readdirSync(bundleDir).filter((name) =>
    statSync(join(bundleDir, name)).isFile(),
  );
  assertSameNames(actualFiles, expectedFiles, "bundle file");

  for (const record of [manifest.notes, ...manifest.assets]) {
    const actual = fileRecord(join(bundleDir, record.name));
    invariant(actual.size === record.size, "size mismatch for " + record.name);
    invariant(actual.digest === record.digest, "digest mismatch for " + record.name);
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
