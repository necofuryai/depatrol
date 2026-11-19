import { parse as parseYAML } from "yaml";
import { decodeBase64UTF8, type GitHubClient, type GitHubContentFile } from "./github.ts";

export const BOT_CONFIG_PATH = ".github/dependabot.yml";

/**
 * Subset of dependabot.yml that M0 interprets.
 */
export interface BotConfig {
  version: number;
  updates: BotConfigEntry[];
}

export interface BotConfigEntry {
  packageEcosystem: string;
  directory: string;
  directories: string[];
  schedule: {
    interval: string;
  };
  cooldown: {
    defaultDays: number;
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function decodeContentFile(file: GitHubContentFile): string {
  const encoding = file.encoding ?? "";
  const content = file.content ?? "";
  if (encoding === "base64") {
    return decodeBase64UTF8(content);
  }
  if (encoding === "") {
    return content;
  }
  throw new Error(`unsupported content encoding: ${encoding}`);
}

/**
 * Parses .github/dependabot.yml YAML content into the M0 BotConfig subset.
 */
export function parseBotConfig(content: string): BotConfig {
  const parsed: unknown = parseYAML(content);
  if (parsed === null || parsed === undefined) {
    return { version: 0, updates: [] };
  }
  const root = asRecord(parsed);
  if (root === null) {
    throw new Error("dependabot.yml must decode to a YAML mapping");
  }

  const versionRaw = root["version"];
  let version = 0;
  if (versionRaw !== undefined && versionRaw !== null) {
    if (typeof versionRaw !== "number" || !Number.isFinite(versionRaw)) {
      throw new Error("dependabot.yml version must be a number");
    }
    version = Math.trunc(versionRaw);
  }

  const updatesRaw = root["updates"];
  const updates: BotConfigEntry[] = [];
  if (updatesRaw !== undefined && updatesRaw !== null) {
    if (!Array.isArray(updatesRaw)) {
      throw new Error("dependabot.yml updates must be a sequence");
    }
    for (const item of updatesRaw) {
      const entry = asRecord(item);
      if (entry === null) {
        if (item === null || item === undefined) {
          updates.push({
            packageEcosystem: "",
            directory: "",
            directories: [],
            schedule: { interval: "" },
            cooldown: { defaultDays: 0 },
          });
          continue;
        }
        throw new Error("dependabot.yml updates entry must be a mapping");
      }

      const packageEcosystem =
        typeof entry["package-ecosystem"] === "string" ? entry["package-ecosystem"] : "";
      const directory = typeof entry["directory"] === "string" ? entry["directory"] : "";

      const directoriesRaw = entry["directories"];
      const directories: string[] = [];
      if (Array.isArray(directoriesRaw)) {
        for (const d of directoriesRaw) {
          if (typeof d === "string") {
            directories.push(d);
          }
        }
      }

      const scheduleRec = asRecord(entry["schedule"]);
      const interval =
        scheduleRec !== null && typeof scheduleRec["interval"] === "string"
          ? scheduleRec["interval"]
          : "";

      const cooldownRec = asRecord(entry["cooldown"]);
      const defaultDaysRaw = cooldownRec?.["default-days"];
      const defaultDays =
        typeof defaultDaysRaw === "number" && Number.isFinite(defaultDaysRaw)
          ? Math.trunc(defaultDaysRaw)
          : 0;

      updates.push({
        packageEcosystem,
        directory,
        directories,
        schedule: { interval },
        cooldown: { defaultDays },
      });
    }
  }

  return { version, updates };
}

/**
 * Reads .github/dependabot.yml from the default branch. A missing file (404)
 * is a valid observation (null config), not an error. M0 only reads the .yml
 * spelling.
 */
export async function fetchBotConfig(
  client: GitHubClient,
  owner: string,
  name: string,
  branch: string,
  signal?: AbortSignal,
): Promise<BotConfig | null> {
  const file = await client.getFileContent(owner, name, BOT_CONFIG_PATH, branch, signal);
  if (file === null) {
    return null;
  }
  const decoded = decodeContentFile(file);
  return parseBotConfig(decoded);
}
