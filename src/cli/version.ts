/**
 * Version resolution matching main.go's buildVersion() contract.
 *
 * Production builds inject __DEPATROL_VERSION__, __DEPATROL_COMMIT__, and
 * __DEPATROL_DATE__ via `bun build --define`. Local and test builds without
 * those defines fall back cleanly to "(devel)".
 */

declare const __DEPATROL_VERSION__: string | undefined;
declare const __DEPATROL_COMMIT__: string | undefined;
declare const __DEPATROL_DATE__: string | undefined;

export interface BuildVersionInfo {
  version?: string;
  commit?: string;
  date?: string;
}

/**
 * Formats build metadata identically to Go's main.go buildVersion():
 *   - fallback "(devel)" when version is empty
 *   - appends " (commit <sha>)" or " (commit <sha>, commit date <date>)" when commit is non-empty
 */
export function formatBuildVersion(info: BuildVersionInfo = {}): string {
  let resolved = info.version && info.version.length > 0 ? info.version : "(devel)";
  if (info.commit && info.commit.length > 0) {
    resolved += ` (commit ${info.commit}`;
    if (info.date && info.date.length > 0) {
      resolved += `, commit date ${info.date}`;
    }
    resolved += ")";
  }
  return resolved;
}

/**
 * Resolves the build version from compile-time `--define` constants, safely
 * falling back to "(devel)" when not defined.
 */
export function resolveBuildVersion(): string {
  const version = typeof __DEPATROL_VERSION__ === "string" ? __DEPATROL_VERSION__ : "";
  const commit = typeof __DEPATROL_COMMIT__ === "string" ? __DEPATROL_COMMIT__ : "";
  const date = typeof __DEPATROL_DATE__ === "string" ? __DEPATROL_DATE__ : "";
  return formatBuildVersion({ version, commit, date });
}
