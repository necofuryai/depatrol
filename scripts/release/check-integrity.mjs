#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function sortedNames(entries) {
  return [...entries].sort((a, b) => a.localeCompare(b));
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

  invariant(tagObject.tag === expected.tag, expected.tag + " tag object changed");
  invariant(tagObject.object.type === "commit", expected.tag + " does not point to a commit");
  invariant(
    tagObject.object.sha === expected.commit,
    expected.tag + " target commit changed",
  );
  invariant(
    tagObject.verification.verified === true &&
      tagObject.verification.reason === "valid",
    expected.tag + " signature is not verified",
  );
}

async function api(repository, path) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "depatrol-release-integrity",
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = "Bearer " + process.env.GITHUB_TOKEN;
  }
  const response = await fetch(
    "https://api.github.com/repos/" + repository + "/" + path,
    { headers },
  );
  if (!response.ok) {
    throw new Error(path + " returned HTTP " + response.status);
  }
  return response.json();
}

export async function checkIntegrity(baseline) {
  invariant(baseline.schemaVersion === 1, "unsupported baseline schema");
  for (const expected of baseline.releases) {
    const release = await api(
      baseline.repository,
      "releases/tags/" + encodeURIComponent(expected.tag),
    );
    const ref = await api(
      baseline.repository,
      "git/ref/tags/" + encodeURIComponent(expected.tag),
    );
    invariant(ref.object.type === "tag", expected.tag + " became a lightweight tag");
    const tagObject = await api(baseline.repository, "git/tags/" + ref.object.sha);
    compareBaseline(expected, release, tagObject);
    console.log("release integrity: verified " + expected.tag);
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
