import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  computeSri,
  createBundle,
  verifyBundle,
  verifyPublishedRelease,
} from "./artifacts.mjs";

const TAG = "v0.2.0";
const VERSION = TAG.slice(1);
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const TARBALL = "depatrol-" + VERSION + ".tgz";

function digest(data) {
  return createHash("sha256").update(data).digest("hex");
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "depatrol-artifacts-"));
  const dist = join(root, "dist");
  const bundle = join(root, "bundle");
  const notes = join(root, "notes.md");
  mkdirSync(dist);
  writeFileSync(join(dist, TARBALL), Buffer.from("fixture:" + TARBALL));
  writeFileSync(notes, "## Changes\n\n- feat: single npm package\n");
  return { root, dist, bundle, notes };
}

test("creates and verifies a single-tarball release bundle", () => {
  const data = fixture();
  try {
    const manifest = createBundle(data.dist, data.bundle, TAG, COMMIT, data.notes);
    assert.equal(manifest.schemaVersion, 2);
    assert.equal(manifest.assets.length, 2);
    const tgzRecord = manifest.assets.find((asset) => asset.name === TARBALL);
    assert.ok(tgzRecord);
    assert.equal(tgzRecord.integrity, computeSri(join(data.bundle, TARBALL)));
    assert.equal(verifyBundle(data.bundle, TAG, COMMIT).tag, TAG);

    const manifestBytes = readFileSync(join(data.bundle, "release-manifest.json"));
    const release = {
      tag_name: TAG,
      draft: false,
      prerelease: false,
      assets: [
        ...manifest.assets.map(({ name, size, digest: d }) => ({
          name,
          size,
          digest: d,
        })),
        {
          name: "release-manifest.json",
          size: manifestBytes.length,
          digest: "sha256:" + digest(manifestBytes),
        },
      ],
    };
    assert.doesNotThrow(() => verifyPublishedRelease(data.bundle, release));
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
});

test("rejects a tampered tarball", () => {
  const data = fixture();
  try {
    createBundle(data.dist, data.bundle, TAG, COMMIT, data.notes);
    const tarballPath = join(data.bundle, TARBALL);
    const tampered = readFileSync(tarballPath);
    tampered[0] ^= 0xff;
    writeFileSync(tarballPath, tampered);
    assert.throws(() => verifyBundle(data.bundle, TAG, COMMIT), /digest mismatch/);
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
});

test("rejects tampered checksums.txt", () => {
  const data = fixture();
  try {
    createBundle(data.dist, data.bundle, TAG, COMMIT, data.notes);
    writeFileSync(
      join(data.bundle, "checksums.txt"),
      "0".repeat(64) + "  " + TARBALL + "\n",
    );
    assert.throws(() => verifyBundle(data.bundle, TAG, COMMIT), /digest mismatch/);
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
});

test("rejects tampered manifest SRI even if sha256 matches", () => {
  const data = fixture();
  try {
    createBundle(data.dist, data.bundle, TAG, COMMIT, data.notes);
    const manifestPath = join(data.bundle, "release-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const tgzRecord = manifest.assets.find((asset) => asset.name === TARBALL);
    tgzRecord.integrity = "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    assert.throws(() => verifyBundle(data.bundle, TAG, COMMIT), /integrity mismatch/);
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
});

test("rejects unexpected extra files and legacy schemaVersion 1", () => {
  const data = fixture();
  try {
    createBundle(data.dist, data.bundle, TAG, COMMIT, data.notes);
    writeFileSync(join(data.bundle, "stray.txt"), "extra\n");
    assert.throws(() => verifyBundle(data.bundle, TAG, COMMIT), /bundle file names differ/);
    rmSync(join(data.bundle, "stray.txt"));

    const manifestPath = join(data.bundle, "release-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.schemaVersion = 1;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    assert.throws(
      () => verifyBundle(data.bundle, TAG, COMMIT),
      /unsupported manifest schema/,
    );
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
});

test("rejects prerelease tag and draft mismatch on published release", () => {
  const data = fixture();
  try {
    assert.throws(
      () => createBundle(data.dist, data.bundle, "v0.2.0-rc.1", COMMIT, data.notes),
      /exact SemVer/,
    );
    const manifest = createBundle(data.dist, data.bundle, TAG, COMMIT, data.notes);
    const manifestBytes = readFileSync(join(data.bundle, "release-manifest.json"));
    const draftRelease = {
      tag_name: TAG,
      draft: true,
      prerelease: false,
      assets: [
        ...manifest.assets,
        {
          name: "release-manifest.json",
          size: manifestBytes.length,
          digest: "sha256:" + digest(manifestBytes),
        },
      ],
    };
    assert.doesNotThrow(() => verifyPublishedRelease(data.bundle, draftRelease, true));
    assert.throws(
      () => verifyPublishedRelease(data.bundle, draftRelease, false),
      /draft state mismatch/,
    );
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
});
