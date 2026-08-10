import assert from "node:assert/strict";
import test from "node:test";

import { compareBaseline } from "./check-integrity.mjs";

const expected = {
  tag: "v1.2.3",
  commit: "0123456789abcdef0123456789abcdef01234567",
  assets: [
    { name: "a.tar.gz", size: 3, digest: "sha256:abc" },
    { name: "checksums.txt", size: 4, digest: "sha256:def" },
  ],
};

const release = {
  tag_name: "v1.2.3",
  draft: false,
  prerelease: false,
  assets: expected.assets,
};

const tagObject = {
  tag: "v1.2.3",
  object: { type: "commit", sha: expected.commit },
  verification: { verified: true, reason: "valid" },
};

test("accepts an unchanged historical release", () => {
  assert.doesNotThrow(() => compareBaseline(expected, release, tagObject));
});

test("rejects a changed asset digest", () => {
  const changed = {
    ...release,
    assets: [
      { ...release.assets[0], digest: "sha256:changed" },
      release.assets[1],
    ],
  };
  assert.throws(
    () => compareBaseline(expected, changed, tagObject),
    /digest changed/,
  );
});

test("rejects a moved tag", () => {
  const moved = {
    ...tagObject,
    object: {
      type: "commit",
      sha: "ffffffffffffffffffffffffffffffffffffffff",
    },
  };
  assert.throws(
    () => compareBaseline(expected, release, moved),
    /target commit changed/,
  );
});
