import assert from "node:assert/strict";
import test from "node:test";

import {
  compareBaseline,
  compareImmutableRelease,
  expectedImmutableAssetNames,
} from "./check-integrity.mjs";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const SHA256 = "sha256:" + "a".repeat(64);

const expected = {
  tag: "v0.1.0",
  commit: COMMIT,
  assets: [
    { name: "depatrol_0.1.0_darwin_arm64.tar.gz", size: 3, digest: SHA256 },
    { name: "depatrol_0.1.0_checksums.txt", size: 4, digest: "sha256:" + "b".repeat(64) },
  ],
};

const baselineRelease = {
  tag_name: "v0.1.0",
  draft: false,
  prerelease: false,
  assets: expected.assets,
};

function signedTag(tag, sha = COMMIT) {
  return {
    tag,
    object: { type: "commit", sha },
    verification: { verified: true, reason: "valid" },
  };
}

function immutableReleaseFor(tag) {
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    immutable: true,
    assets: expectedImmutableAssetNames(tag).map((name, index) => ({
      name,
      size: 100 + index,
      digest: SHA256,
    })),
  };
}

test("accepts an unchanged historical baseline release", () => {
  assert.doesNotThrow(() =>
    compareBaseline(expected, baselineRelease, signedTag("v0.1.0")),
  );
});

test("rejects a changed baseline asset digest", () => {
  const changed = {
    ...baselineRelease,
    assets: [
      { ...baselineRelease.assets[0], digest: "sha256:changed" },
      baselineRelease.assets[1],
    ],
  };
  assert.throws(
    () => compareBaseline(expected, changed, signedTag("v0.1.0")),
    /digest changed/,
  );
});

test("rejects a moved baseline tag", () => {
  const moved = signedTag("v0.1.0", "f".repeat(40));
  assert.throws(
    () => compareBaseline(expected, baselineRelease, moved),
    /target commit changed/,
  );
});

test("accepts a v0.1.x immutable Go binary release", () => {
  const release = immutableReleaseFor("v0.1.6");
  assert.equal(release.assets.length, 7);
  assert.doesNotThrow(() =>
    compareImmutableRelease(release, signedTag("v0.1.6")),
  );
});

test("accepts a v0.2.0+ immutable single npm tarball release", () => {
  const release = immutableReleaseFor("v0.2.0");
  assert.deepEqual(
    release.assets.map((asset) => asset.name),
    ["checksums.txt", "depatrol-0.2.0.tgz", "release-manifest.json"],
  );
  assert.doesNotThrow(() =>
    compareImmutableRelease(release, signedTag("v0.2.0")),
  );
});

test("rejects a mutable post-baseline release", () => {
  const release = { ...immutableReleaseFor("v0.2.0"), immutable: false };
  assert.throws(
    () => compareImmutableRelease(release, signedTag("v0.2.0")),
    /not immutable/,
  );
});

test("rejects a v0.2.0 release with unexpected or missing assets", () => {
  const release = immutableReleaseFor("v0.2.0");
  release.assets = release.assets.filter((asset) => asset.name !== "checksums.txt");
  assert.throws(
    () => compareImmutableRelease(release, signedTag("v0.2.0")),
    /asset names mismatch/,
  );
});

test("rejects an immutable release with missing sha256 digest or unverified tag", () => {
  const missingDigest = immutableReleaseFor("v0.2.0");
  missingDigest.assets[0].digest = null;
  assert.throws(
    () => compareImmutableRelease(missingDigest, signedTag("v0.2.0")),
    /missing or invalid sha256 digest/,
  );

  const unverifiedTag = {
    ...signedTag("v0.2.0"),
    verification: { verified: false, reason: "unsigned" },
  };
  assert.throws(
    () => compareImmutableRelease(immutableReleaseFor("v0.2.0"), unverifiedTag),
    /signature is not verified/,
  );
});
