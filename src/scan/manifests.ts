import { posix } from "node:path";
import type { BotConfigEntry } from "./botconfig.ts";

/**
 * A dependency manifest observed on the default branch.
 */
export interface Manifest {
  path: string;
  /** dependabot.yml package-ecosystem vocabulary */
  ecosystem: string;
}

/**
 * Maps well-known manifest base names to the package-ecosystem vocabulary of
 * dependabot.yml. Recognizing a file name is observation interpretation, not
 * version resolution (ADR 0003).
 */
const MANIFEST_BASE_NAMES: Readonly<Record<string, string>> = {
  "package.json": "npm",
  "go.mod": "gomod",
  "requirements.txt": "pip",
  "pyproject.toml": "pip",
  Pipfile: "pip",
  Gemfile: "bundler",
  "Cargo.toml": "cargo",
  "composer.json": "composer",
  "pom.xml": "maven",
  "build.gradle": "gradle",
  "build.gradle.kts": "gradle",
  Dockerfile: "docker",
};

export function detectManifests(paths: readonly string[]): Manifest[] {
  const out: Manifest[] = [];
  for (const p of paths) {
    const base = posix.basename(p);
    if (Object.hasOwn(MANIFEST_BASE_NAMES, base)) {
      const eco = MANIFEST_BASE_NAMES[base];
      if (eco !== undefined) {
        out.push({ path: p, ecosystem: eco });
      }
      continue;
    }
    if (p.startsWith(".github/workflows/") && (p.endsWith(".yml") || p.endsWith(".yaml"))) {
      out.push({ path: p, ecosystem: "github-actions" });
    }
  }
  return out;
}

/**
 * Matches Go's path.Clean(p) on POSIX slash paths (stripping trailing slashes
 * except for root "/").
 */
export function cleanPosixPath(p: string): string {
  if (p === "") {
    return ".";
  }
  const normalized = posix.normalize(p);
  if (normalized.length > 1 && normalized.endsWith("/")) {
    return normalized.slice(0, -1);
  }
  return normalized;
}

/**
 * Maps a file path to the shared directory vocabulary used by dependabot.yml
 * entries, PR titles, and alert manifest paths: "/" for the repository root,
 * "/sub/dir" otherwise.
 */
export function directoryOf(p: string): string {
  const dir = posix.dirname(p);
  if (dir === ".") {
    return "/";
  }
  return `/${dir}`;
}

/**
 * Returns the dependabot.yml directory that would cover this manifest.
 * Workflow files are covered by a github-actions entry with directory "/" by
 * Dependabot convention.
 */
export function manifestDirectory(m: Manifest): string {
  if (m.ecosystem === "github-actions") {
    return "/";
  }
  return directoryOf(m.path);
}

/**
 * Reports whether the entry covers the manifest: same ecosystem and an exactly
 * matching directory. Glob directory matching is outside M0.
 */
export function entryCovers(entry: BotConfigEntry, m: Manifest): boolean {
  if (entry.packageEcosystem !== m.ecosystem) {
    return false;
  }
  const targetDir = manifestDirectory(m);
  if (entry.directory !== "" && cleanPosixPath(entry.directory) === targetDir) {
    return true;
  }
  for (const d of entry.directories) {
    if (cleanPosixPath(d) === targetDir) {
      return true;
    }
  }
  return false;
}

export function anyEntryCovers(entries: readonly BotConfigEntry[], m: Manifest): boolean {
  for (const e of entries) {
    if (entryCovers(e, m)) {
      return true;
    }
  }
  return false;
}
