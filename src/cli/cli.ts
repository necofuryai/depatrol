/**
 * CLI wiring for depatrol. Everything impure is an injection point in
 * RunOptions so tests can drive the real pipeline through a recorded HTTP
 * transport and a fixed clock — the project's single seam.
 */

import { normalizeTarget, serializeReport } from "../domain/domain.ts";
import { Scanner, createGitHubClient, type FetchLike } from "../scan/index.ts";
import { renderTable } from "./table.ts";

export interface Writable {
  write(chunk: string): unknown;
}

export interface RunOptions {
  fetch?: FetchLike;
  now?: () => Date;
  stdout?: Writable;
  stderr?: Writable;
  env?: Record<string, string | undefined>;
  /** Version string printed by --version / -v; empty falls back to "(devel)". */
  version?: string;
  /** Optional GitHub API request pacing override (requests per second). */
  paceRatePerSec?: number;
}

class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

const ROOT_HELP = `Read-only control plane for dependency update bots

Usage:
  depatrol [command]

Available Commands:
  help        Help about any command
  scan        Scan repositories and report their conditions with evidence

Flags:
  -h, --help      help for depatrol
  -v, --version   version for depatrol

Use "depatrol [command] --help" for more information about a command.
`;

const SCAN_HELP = `Scan repositories and report their conditions with evidence

Usage:
  depatrol scan [flags]

Flags:
  -h, --help            help for scan
      --org string      scan every non-archived repository of this organization
      --output string   output format: json or table (default "table")
      --repo stringArray   repository to scan as owner/name (repeatable)
`;

interface ParsedScanArgs {
  kind: "scan";
  repos: string[];
  org: string;
  output: string;
}

type ParsedCommand =
  | { kind: "help"; topic: "root" | "scan" }
  | { kind: "version" }
  | ParsedScanArgs;

function parseScanArgs(args: readonly string[]): ParsedCommand {
  const repos: string[] = [];
  let org = "";
  let output = "table";

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === undefined) {
      break;
    }

    if (arg === "--") {
      const rest = args.slice(i + 1);
      if (rest.length > 0) {
        throw new UsageError(`unexpected argument ${JSON.stringify(rest[0])}`);
      }
      break;
    }

    if (arg === "-h" || arg === "--help") {
      return { kind: "help", topic: "scan" };
    }

    if (arg === "--repo" || arg.startsWith("--repo=")) {
      const value = readFlagValue(args, i, "--repo");
      repos.push(value.value);
      i = value.nextIndex;
      continue;
    }

    if (arg === "--org" || arg.startsWith("--org=")) {
      const value = readFlagValue(args, i, "--org");
      org = value.value;
      i = value.nextIndex;
      continue;
    }

    if (arg === "--output" || arg.startsWith("--output=")) {
      const value = readFlagValue(args, i, "--output");
      output = value.value;
      i = value.nextIndex;
      continue;
    }

    if (arg.startsWith("-")) {
      const flagName = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
      throw new UsageError(`unknown flag: ${flagName}`);
    }

    throw new UsageError(`unexpected argument ${JSON.stringify(arg)}`);
  }

  return { kind: "scan", repos, org, output };
}

function readFlagValue(
  args: readonly string[],
  index: number,
  flag: string,
): { value: string; nextIndex: number } {
  const current = args[index] ?? "";
  const eqPrefix = `${flag}=`;
  if (current.startsWith(eqPrefix)) {
    return { value: current.slice(eqPrefix.length), nextIndex: index + 1 };
  }
  const next = args[index + 1];
  if (next === undefined) {
    throw new UsageError(`flag needs an argument: ${flag}`);
  }
  return { value: next, nextIndex: index + 2 };
}

function parseRootArgs(args: readonly string[]): ParsedCommand {
  if (args.length === 0) {
    return { kind: "help", topic: "root" };
  }

  const first = args[0] ?? "";
  if (first === "-h" || first === "--help") {
    return { kind: "help", topic: "root" };
  }
  if (first === "-v" || first === "--version") {
    if (args.length > 1) {
      const extra = args[1] ?? "";
      if (extra === "-h" || extra === "--help") {
        return { kind: "help", topic: "root" };
      }
      if (extra.startsWith("-")) {
        const flagName = extra.includes("=") ? extra.slice(0, extra.indexOf("=")) : extra;
        throw new UsageError(`unknown flag: ${flagName}`);
      }
      throw new UsageError(`unknown command ${JSON.stringify(extra)} for "depatrol"`);
    }
    return { kind: "version" };
  }
  if (first === "help") {
    const topic = args[1];
    if (topic === undefined || topic === "-h" || topic === "--help") {
      return { kind: "help", topic: "root" };
    }
    if (topic === "scan") {
      return { kind: "help", topic: "scan" };
    }
    throw new UsageError(`unknown help topic ${JSON.stringify(topic)}`);
  }
  if (first === "scan") {
    return parseScanArgs(args.slice(1));
  }
  if (first.startsWith("-")) {
    const flagName = first.includes("=") ? first.slice(0, first.indexOf("=")) : first;
    throw new UsageError(`unknown flag: ${flagName}`);
  }
  throw new UsageError(`unknown command ${JSON.stringify(first)} for "depatrol"`);
}

/**
 * Deduplicates repository targets while preserving their first-seen order.
 */
export function deduplicateTargets(targets: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const target of targets) {
    if (!seen.has(target)) {
      seen.add(target);
      result.push(target);
    }
  }
  return result;
}

function formatErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

/**
 * Executes the depatrol CLI and returns the process exit code:
 * - 0 when a report was produced (per-repository scan errors are data, not failures),
 *   or when printing --version / --help
 * - 1 for operational failures (e.g. organization repository listing errors)
 * - 2 for usage errors (missing target, invalid output format, missing token, unknown flags/commands)
 */
export async function run(args: readonly string[], opts: RunOptions = {}): Promise<number> {
  const stdout: Writable = opts.stdout ?? process.stdout;
  const stderr: Writable = opts.stderr ?? process.stderr;
  const now = opts.now ?? (() => new Date());
  const env = opts.env ?? process.env;
  const version = opts.version && opts.version.length > 0 ? opts.version : "(devel)";

  try {
    const parsed = parseRootArgs(args);

    if (parsed.kind === "help") {
      stdout.write(parsed.topic === "scan" ? SCAN_HELP : ROOT_HELP);
      return 0;
    }

    if (parsed.kind === "version") {
      stdout.write(`depatrol version ${version}\n`);
      return 0;
    }

    const { repos, org, output } = parsed;

    if (repos.length === 0 && org === "") {
      throw new UsageError("at least one --repo owner/name or an --org is required");
    }
    if (output !== "json" && output !== "table") {
      throw new UsageError(`unknown output format ${JSON.stringify(output)} (json|table)`);
    }

    const rawGithubToken = env.GITHUB_TOKEN;
    const rawGhToken = env.GH_TOKEN;
    const token =
      rawGithubToken && rawGithubToken.length > 0
        ? rawGithubToken
        : rawGhToken && rawGhToken.length > 0
          ? rawGhToken
          : "";
    if (token === "") {
      throw new UsageError("GITHUB_TOKEN (or GH_TOKEN) is not set; depatrol needs a read-only token");
    }

    const client = createGitHubClient({
      token,
      ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
      ...(opts.paceRatePerSec !== undefined ? { paceRatePerSec: opts.paceRatePerSec } : {}),
    });

    const scanner = new Scanner(client, now);
    let targets: string[] = [...repos];
    if (org !== "") {
      let orgTargets: string[];
      try {
        orgTargets = await scanner.listOrganizationRepositories(org);
      } catch (err) {
        throw new Error(`listing repositories of ${org}: ${formatErrorMessage(err)}`);
      }
      targets = [...orgTargets, ...targets];
    }

    targets = deduplicateTargets(targets);

    const report = await scanner.scanRepositories(targets);
    report.target = normalizeTarget({
      ...(org !== "" ? { org } : {}),
      ...(repos.length > 0 ? { repos: [...repos] } : {}),
    });

    if (output === "json") {
      stdout.write(serializeReport(report));
    } else {
      stdout.write(renderTable(report));
    }
    return 0;
  } catch (err) {
    stderr.write(`Error: ${formatErrorMessage(err)}\n`);
    if (err instanceof UsageError) {
      return 2;
    }
    return 1;
  }
}
