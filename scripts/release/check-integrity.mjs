#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const STABLE_TAG_PATTERN = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function sortedNames(entries) {
  return [...entries].sort((a, b) => a.localeCompare(b));
}

export function parseStableTag(tag) {
  const match = STABLE_TAG_PATTERN.exec(tag);
  invariant(match, "unexpected non-SemVer release tag: " + tag);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    version: tag.slice(1),
  };
}

export function expectedImmutableAssetNames(tag) {
  const { major, minor, version } = parseStableTag(tag);
  if (major === 0 && minor === 1) {
    return [
      "depatrol_" + version + "_checksums.txt",
      "depatrol_" + version + "_darwin_amd64.tar.gz",
      "depatrol_" + version + "_darwin_arm64.tar.gz",
      "depatrol_" + version + "_linux_amd64.tar.gz",
      "depatrol_" + version + "_linux_arm64.tar.gz",
      "depatrol_" + version + "_windows_amd64.zip",
      "release-manifest.json",
    ];
  }
  return [
    "checksums.txt",
    "depatrol-" + version + ".tgz",
    "release-manifest.json",
  ];
}

function verifyTagObject(expectedTag, tagObject, expectedCommit = null) {
  invariant(tagObject.tag === expectedTag, expectedTag + " tag object changed");
  invariant(
    tagObject.object?.type === "commit",
    expectedTag + " does not point to a commit",
  );
  invariant(
    COMMIT_SHA_PATTERN.test(tagObject.object?.sha ?? ""),
    expectedTag + " target commit is invalid",
  );
  if (expectedCommit !== null) {
    invariant(
      tagObject.object.sha === expectedCommit,
      expectedTag + " target commit changed",
    );
  }
  invariant(
    tagObject.verification?.verified === true &&
      tagObject.verification?.reason === "valid",
    expectedTag + " signature is not verified",
  );
}

export function compareBaseline(expected, release, tagObject) {
  invariant(release.tag_name === expected.tag, "release tag mismatch");
  invariant(release.draft === false, expected.tag + " is a draft");
  invariant(release.prerelease === false, expected.tag + " is a prerelease");

  const actualAssets = release.assets.map((asset) => ({
    name: asset.name,
    size: asset.size,
    digest: asset.digest,
  }));
  const expectedNames = sortedNames(expected.assets.map((asset) => asset.name));
  const actualNames = sortedNames(actualAssets.map((asset) => asset.name));
  invariant(
    JSON.stringify(actualNames) === JSON.stringify(expectedNames),
    expected.tag + " asset names changed",
  );

  const byName = new Map(actualAssets.map((asset) => [asset.name, asset]));
  for (const asset of expected.assets) {
    const actual = byName.get(asset.name);
    invariant(actual.size === asset.size, expected.tag + " size changed: " + asset.name);
    invariant(
      actual.digest === asset.digest,
      expected.tag + " digest changed: " + asset.name,
    );
  }

  verifyTagObject(expected.tag, tagObject, expected.commit);
}

export function compareImmutableRelease(release, tagObject) {
  const tag = release.tag_name;
  parseStableTag(tag);
  invariant(release.draft === false, tag + " is a draft");
  invariant(release.prerelease === false, tag + " is a prerelease");
  invariant(release.immutable === true, tag + " is not immutable");
  invariant(Array.isArray(release.assets), tag + " assets must be an array");

  const expectedNames = sortedNames(expectedImmutableAssetNames(tag));
  const actualNames = sortedNames(release.assets.map((asset) => asset.name));
  invariant(
    JSON.stringify(actualNames) === JSON.stringify(expectedNames),
    tag +
      " asset names mismatch:\nactual: " +
      actualNames.join(", ") +
      "\nexpected: " +
      expectedNames.join(", "),
  );

  for (const asset of release.assets) {
    invariant(
      typeof asset.size === "number" && asset.size > 0,
      tag + " invalid asset size: " + asset.name,
    );
    invariant(
      typeof asset.digest === "string" && SHA256_DIGEST_PATTERN.test(asset.digest),
      tag + " missing or invalid sha256 digest: " + asset.name,
    );
  }

  verifyTagObject(tag, tagObject);
}

function buildHeaders() {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "depatrol-release-integrity",
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = "Bearer " + process.env.GITHUB_TOKEN;
  }
  return headers;
}

function nextLink(linkHeader) {
  if (!linkHeader) {
    return null;
  }
  for (const part of linkHeader.split(",")) {
    const match = /<([^>]+)>;\s*rel="next"/.exec(part.trim());
    if (match) {
      const url = match[1];
      invariant(
        url.startsWith("https://api.github.com/"),
        "refusing unexpected pagination host: " + url,
      );
      return url;
    }
  }
  return null;
}

async function apiUrl(url) {
  const response = await fetch(url, { headers: buildHeaders() });
  if (!response.ok) {
    throw new Error(url + " returned HTTP " + response.status);
  }
  return {
    data: await response.json(),
    next: nextLink(response.headers.get("link")),
  };
}

async function api(repository, path) {
  const { data } = await apiUrl(
    "https://api.github.com/repos/" + repository + "/" + path,
  );
  return data;
}

async function listPublishedReleases(repository) {
  const releases = [];
  let url =
    "https://api.github.com/repos/" + repository + "/releases?per_page=100";
  while (url) {
    const { data, next } = await apiUrl(url);
    invariant(Array.isArray(data), "releases response must be an array");
    for (const release of data) {
      if (release.draft === false && release.prerelease === false) {
        releases.push(release);
      }
    }
    url = next;
  }
  return releases;
}

async function fetchSignedTagObject(repository, tag) {
  const ref = await api(
    repository,
    "git/ref/tags/" + encodeURIComponent(tag),
  );
  invariant(ref.object?.type === "tag", tag + " became a lightweight tag");
  return api(repository, "git/tags/" + ref.object.sha);
}

export async function checkIntegrity(baseline) {
  invariant(baseline.schemaVersion === 1, "unsupported baseline schema");
  const baselineTags = new Set();

  for (const expected of baseline.releases) {
    baselineTags.add(expected.tag);
    const release = await api(
      baseline.repository,
      "releases/tags/" + encodeURIComponent(expected.tag),
    );
    const tagObject = await fetchSignedTagObject(baseline.repository, expected.tag);
    compareBaseline(expected, release, tagObject);
    console.log("release integrity: verified baseline " + expected.tag);
  }

  const published = await listPublishedReleases(baseline.repository);
  for (const release of published) {
    if (baselineTags.has(release.tag_name)) {
      continue;
    }
    const tagObject = await fetchSignedTagObject(
      baseline.repository,
      release.tag_name,
    );
    compareImmutableRelease(release, tagObject);
    console.log("release integrity: verified immutable " + release.tag_name);
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: check-integrity.mjs <baseline-json>");
    process.exit(2);
  }
  try {
    await checkIntegrity(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    console.error("release integrity: " + error.message);
    process.exitCode = 1;
  }
}
