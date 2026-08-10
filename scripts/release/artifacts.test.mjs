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
  createBundle,
  verifyBundle,
  verifyPublishedRelease,
} from "./artifacts.mjs";

const TAG = "v1.2.3";
const VERSION = TAG.slice(1);
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const ARCHIVES = [
  "depatrol_" + VERSION + "_darwin_amd64.tar.gz",
  "depatrol_" + VERSION + "_darwin_arm64.tar.gz",
  "depatrol_" + VERSION + "_linux_amd64.tar.gz",
  "depatrol_" + VERSION + "_linux_arm64.tar.gz",
  "depatrol_" + VERSION + "_windows_amd64.zip",
];

function digest(data) {
  return createHash("sha256").update(data).digest("hex");
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "depatrol-artifacts-"));
  const dist = join(root, "dist");
  const bundle = join(root, "bundle");
  const notes = join(root, "notes.md");
  mkdirSync(dist);
  writeFileSync(
    join(dist, "metadata.json"),
    JSON.stringify({
      project_name: "depatrol",
      version: VERSION,
      commit: COMMIT,
    }),
  );
  const checksumLines = [];
  for (const name of ARCHIVES) {
    const content = Buffer.from("fixture:" + name);
    writeFileSync(join(dist, name), content);
    checksumLines.push(digest(content) + "  " + name);
  }
  writeFileSync(
    join(dist, "depatrol_" + VERSION + "_checksums.txt"),
    checksumLines.join("\n") + "\n",
  );
  writeFileSync(notes, "# v1.2.3\n");
  return { root, dist, bundle, notes };
}

test("creates and verifies an exact release bundle", () => {
  const data = fixture();
  try {
    const manifest = createBundle(data.dist, data.bundle, TAG, COMMIT, data.notes);
    assert.equal(manifest.assets.length, 6);
    assert.equal(verifyBundle(data.bundle, TAG, COMMIT).tag, TAG);

    const release = {
      tag_name: TAG,
      draft: false,
      prerelease: false,
      assets: [
        ...manifest.assets,
        {
          name: "release-manifest.json",
          size: readFileSync(join(data.bundle, "release-manifest.json")).length,
          digest:
            "sha256:" +
            digest(readFileSync(join(data.bundle, "release-manifest.json"))),
        },
      ],
    };
    assert.doesNotThrow(() => verifyPublishedRelease(data.bundle, release));
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
});

test("rejects a modified archive", () => {
  const data = fixture();
  try {
    createBundle(data.dist, data.bundle, TAG, COMMIT, data.notes);
    const archivePath = join(data.bundle, ARCHIVES[0]);
    const tampered = readFileSync(archivePath);
    tampered[0] ^= 0xff;
    writeFileSync(archivePath, tampered);
    assert.throws(() => verifyBundle(data.bundle, TAG, COMMIT), /digest mismatch/);
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
});
