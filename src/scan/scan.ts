import {
  Confidence,
  EvidenceMethod,
  FindingType,
  SubjectKind,
  computeRollup,
  formatRFC3339,
  weakestLink,
  type Evidence,
  type Finding,
  type Report,
  type RepositoryReport,
} from "../domain/domain.ts";
import { BOT_CONFIG_PATH, fetchBotConfig, type BotConfigEntry } from "./botconfig.ts";
import {
  GitHubAPIError,
  GitHubRateLimitError,
  GitHubSecondaryRateLimitError,
  type GitHubClient,
  type GitHubDependabotAlert,
  type GitHubPullRequest,
} from "./github.ts";
import { anyEntryCovers, detectManifests, manifestDirectory } from "./manifests.ts";
import {
  DEPENDABOT_LOGIN,
  MS_PER_DAY,
  deriveVulnerable,
  formatRFC3339Seconds,
  judgeExpectedUpdates,
  makeEvidence,
  parseTimestampOrZero,
  type Observation,
  type PRDetail,
} from "./updates.ts";

/**
 * Translates dependabot.yml schedule intervals into days. Unrecognized
 * intervals are judged at the most lenient cadence so a config feature M0 does
 * not model can never produce a false stall.
 */
const INTERVAL_DAYS: Readonly<Record<string, number>> = {
  daily: 1,
  weekly: 7,
  monthly: 31,
};

/**
 * Expected-output window for one config entry: two full schedule intervals
 * plus the configured cooldown.
 */
export function entryWindowDays(e: BotConfigEntry): number {
  const interval = e.schedule.interval;
  const d = Object.hasOwn(INTERVAL_DAYS, interval) ? (INTERVAL_DAYS[interval] ?? 31) : 31;
  return 2 * d + e.cooldown.defaultDays;
}

class StageError extends Error {
  readonly stage: string;

  constructor(stage: string, cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(message);
    this.name = "StageError";
    this.stage = stage;
  }
}

export class Scanner {
  private readonly client: GitHubClient;
  private readonly now: () => Date;

  constructor(client: GitHubClient, now: () => Date = () => new Date()) {
    this.client = client;
    this.now = now;
  }

  /**
   * Resolves an organization into scan targets. Archived repositories are
   * skipped: update bots do not run on them, so scanning them could only
   * produce false stall findings.
   */
  async listOrganizationRepositories(org: string, signal?: AbortSignal): Promise<string[]> {
    const repos = await this.client.listOrgRepositories(org, signal);
    const targets: string[] = [];
    for (const r of repos) {
      if (r.archived === true) {
        continue;
      }
      targets.push(r.full_name ?? "");
    }
    return targets;
  }

  /**
   * Scans each "owner/name" target. A repository that fails mid-fetch becomes
   * a ScanError and the scan continues.
   */
  async scanRepositories(targets: readonly string[], signal?: AbortSignal): Promise<Report> {
    const report: Report = {
      observed_at: formatRFC3339(this.now()),
      target: {},
      repositories: [],
      scan_errors: [],
    };

    for (const target of targets) {
      const slashIdx = target.indexOf("/");
      if (slashIdx === -1) {
        report.scan_errors.push({
          repository: target,
          stage: "target",
          message: "target must be owner/name",
        });
        continue;
      }
      const owner = target.slice(0, slashIdx);
      const name = target.slice(slashIdx + 1);
      try {
        const rr = await this.scanRepository(owner, name, signal);
        report.repositories.push(rr);
      } catch (err) {
        if (err instanceof StageError) {
          report.scan_errors.push({
            repository: target,
            stage: err.stage,
            message: err.message,
          });
        } else {
          report.scan_errors.push({
            repository: target,
            stage: "unknown",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    return report;
  }

  private async scanRepository(
    owner: string,
    name: string,
    signal?: AbortSignal,
  ): Promise<RepositoryReport> {
    const obs = await this.observe(owner, name, signal);

    const findings: Finding[] = [];
    findings.push(...this.judgeCoverage(obs));
    findings.push(...this.judgePausedOrStalled(obs));

    const updates = judgeExpectedUpdates(this.now, obs);
    findings.push(...deriveVulnerable(this.now, updates));

    return {
      repository: `${owner}/${name}`,
      default_branch: obs.defaultBranch,
      rollup: computeRollup(findings, updates),
      findings,
      expected_updates: updates,
    };
  }

  private async observe(
    owner: string,
    name: string,
    signal?: AbortSignal,
  ): Promise<Observation> {
    let defaultBranch: string;
    try {
      const repo = await this.client.getRepository(owner, name, signal);
      defaultBranch = repo.default_branch ?? "";
    } catch (err) {
      throw new StageError("repository", err);
    }

    const treePaths: string[] = [];
    try {
      const tree = await this.client.getGitTree(owner, name, defaultBranch, true, signal);
      if (tree.truncated === true) {
        throw new Error(
          "recursive Git tree response was truncated; manifest coverage cannot be judged safely",
        );
      }
      for (const entry of tree.tree ?? []) {
        if (entry.type === "blob") {
          treePaths.push(entry.path ?? "");
        }
      }
    } catch (err) {
      throw new StageError("tree", err);
    }

    let config;
    try {
      config = await fetchBotConfig(this.client, owner, name, defaultBranch, signal);
    } catch (err) {
      throw new StageError("bot_config", err);
    }

    let securityFixes;
    try {
      securityFixes = await this.client.getAutomatedSecurityFixes(owner, name, signal);
    } catch (err) {
      throw new StageError("security_fixes", err);
    }

    let openAlerts: GitHubDependabotAlert[] = [];
    let fixedAlerts: GitHubDependabotAlert[] = [];
    let alertsDisabled = false;

    try {
      const openResult = await this.fetchAlerts(owner, name, "open", signal);
      openAlerts = openResult.alerts;
      alertsDisabled = openResult.disabled;
    } catch (err) {
      throw new StageError("alerts_open", err);
    }

    if (!alertsDisabled) {
      try {
        const fixedResult = await this.fetchAlerts(owner, name, "fixed", signal);
        fixedAlerts = fixedResult.alerts;
      } catch (err) {
        throw new StageError("alerts_fixed", err);
      }
    }

    let lastBotCommit: Date | null = null;
    try {
      const commits = await this.client.listCommits(owner, name, DEPENDABOT_LOGIN, 1, signal);
      if (commits !== null && commits.length > 0) {
        const first = commits[0];
        lastBotCommit = parseTimestampOrZero(first?.commit?.committer?.date);
      }
    } catch (err) {
      throw new StageError("commits", err);
    }

    let openPRs: GitHubPullRequest[];
    try {
      openPRs = await this.fetchBotPRs(owner, name, "open", signal);
    } catch (err) {
      throw new StageError("pulls_open", err);
    }

    let closedPRs: GitHubPullRequest[];
    try {
      closedPRs = await this.fetchBotPRs(owner, name, "closed", signal);
    } catch (err) {
      throw new StageError("pulls_closed", err);
    }

    const prDetails = new Map<number, PRDetail>();
    for (const pr of openPRs) {
      const n = pr.number ?? 0;

      let full: GitHubPullRequest;
      try {
        full = await this.client.getPullRequest(owner, name, n, signal);
      } catch (err) {
        throw new StageError("pull_detail", err);
      }

      let reviews;
      try {
        reviews = await this.client.listPullRequestReviews(owner, name, n, signal);
      } catch (err) {
        throw new StageError("pull_reviews", err);
      }

      let checks;
      try {
        checks = await this.client.listCheckRunsForRef(owner, name, pr.head?.sha ?? "", signal);
      } catch (err) {
        throw new StageError("pull_checks", err);
      }

      prDetails.set(n, { full, reviews, checks });
    }

    return {
      owner,
      name,
      defaultBranch,
      treePaths,
      config,
      securityFixes,
      openAlerts,
      fixedAlerts,
      openPRs,
      closedPRs,
      prDetails,
      lastBotCommit,
      alertsDisabled,
    };
  }

  /**
   * Lists alerts in one state. GitHub answers 403 on this route for three
   * different reasons; only "alerts are disabled" is an answer rather than a
   * failure, and it must never be conflated with rate limiting or missing scope.
   */
  private async fetchAlerts(
    owner: string,
    name: string,
    state: string,
    signal?: AbortSignal,
  ): Promise<{ alerts: GitHubDependabotAlert[]; disabled: boolean }> {
    try {
      const alerts = await this.client.listRepoAlerts(owner, name, state, signal);
      return { alerts, disabled: false };
    } catch (err) {
      if (err instanceof GitHubRateLimitError || err instanceof GitHubSecondaryRateLimitError) {
        throw err;
      }
      if (
        err instanceof GitHubAPIError &&
        err.status === 403 &&
        err.apiMessage.toLowerCase().includes("disabled")
      ) {
        return { alerts: [], disabled: true };
      }
      throw err;
    }
  }

  private async fetchBotPRs(
    owner: string,
    name: string,
    state: string,
    signal?: AbortSignal,
  ): Promise<GitHubPullRequest[]> {
    const prs = await this.client.listPullRequests(owner, name, state, signal);
    return prs.filter((pr) => pr.user?.login === DEPENDABOT_LOGIN);
  }

  private judgeCoverage(obs: Observation): Finding[] {
    const findings: Finding[] = [];
    for (const m of detectManifests(obs.treePaths)) {
      if (obs.config !== null && anyEntryCovers(obs.config.updates, m)) {
        continue;
      }
      const evidence: Evidence[] = [
        makeEvidence(
          this.now(),
          `GET /repos/${obs.owner}/${obs.name}/git/trees/${obs.defaultBranch}?recursive=1`,
          EvidenceMethod.APIRead,
          `manifest ${m.path} (${m.ecosystem}) is present on the default branch`,
          Confidence.Confirmed,
        ),
      ];
      if (obs.config === null) {
        evidence.push(
          makeEvidence(
            this.now(),
            `GET /repos/${obs.owner}/${obs.name}/contents/${BOT_CONFIG_PATH}`,
            EvidenceMethod.APIRead,
            "no .github/dependabot.yml exists on the default branch",
            Confidence.Confirmed,
          ),
        );
      } else {
        evidence.push(
          makeEvidence(
            this.now(),
            `GET /repos/${obs.owner}/${obs.name}/contents/${BOT_CONFIG_PATH}`,
            EvidenceMethod.APIRead,
            `.github/dependabot.yml has no ${m.ecosystem} entry whose directory covers ${manifestDirectory(m)}`,
            Confidence.Confirmed,
          ),
        );
      }
      findings.push({
        type: FindingType.CoverageGap,
        subject: { kind: SubjectKind.Manifest, id: m.path },
        confidence: weakestLink(evidence),
        detail: `manifest ${m.path} (${m.ecosystem}) has no covering update-bot configuration`,
        evidence,
      });
    }

    if (obs.alertsDisabled) {
      const evidence: Evidence[] = [
        makeEvidence(
          this.now(),
          `GET /repos/${obs.owner}/${obs.name}/dependabot/alerts`,
          EvidenceMethod.APIRead,
          'the alerts endpoint answered 403 with "Dependabot alerts are disabled for this repository"',
          Confidence.Confirmed,
        ),
      ];
      findings.push({
        type: FindingType.CoverageGap,
        subject: { kind: SubjectKind.BotConfig, id: "dependabot-alerts" },
        confidence: weakestLink(evidence),
        detail:
          "Dependabot alerts are disabled: no security-alert source exists for this repository",
        evidence,
      });
    }

    return findings;
  }

  private judgePausedOrStalled(obs: Observation): Finding[] {
    if (obs.securityFixes?.paused === true) {
      const evidence: Evidence[] = [
        makeEvidence(
          this.now(),
          `GET /repos/${obs.owner}/${obs.name}/automated-security-fixes`,
          EvidenceMethod.APIRead,
          "Dependabot security updates are paused for this repository",
          Confidence.Confirmed,
        ),
      ];
      return [
        {
          type: FindingType.PausedOrStalled,
          subject: { kind: SubjectKind.BotConfig, id: BOT_CONFIG_PATH },
          confidence: weakestLink(evidence),
          detail:
            "Dependabot security updates are paused (GitHub pauses after 90 days of untouched PRs or repeated run failures)",
          evidence,
        },
      ];
    }

    if (
      obs.config === null ||
      obs.config.updates.length === 0 ||
      detectManifests(obs.treePaths).length === 0
    ) {
      return [];
    }

    let lastPR: GitHubPullRequest | null = null;
    for (const pr of [...obs.openPRs, ...obs.closedPRs]) {
      if (
        lastPR === null ||
        parseTimestampOrZero(pr.created_at).getTime() >
          parseTimestampOrZero(lastPR.created_at).getTime()
      ) {
        lastPR = pr;
      }
    }

    let lastActivity: Date | null = null;
    let activityDescription =
      "no Dependabot pull request or default-branch bot commit is observable (all listed open and closed PRs; newest authored commit)";
    if (lastPR !== null) {
      const t = parseTimestampOrZero(lastPR.created_at);
      lastActivity = t;
      activityDescription = `newest Dependabot pull request #${lastPR.number ?? 0} was created ${formatRFC3339Seconds(t)}`;
    }
    if (
      obs.lastBotCommit !== null &&
      (lastActivity === null || obs.lastBotCommit.getTime() > lastActivity.getTime())
    ) {
      lastActivity = obs.lastBotCommit;
      activityDescription = `newest default-branch commit authored by the bot is from ${formatRFC3339Seconds(obs.lastBotCommit)}`;
    }

    let window = 0;
    for (const e of obs.config.updates) {
      const w = entryWindowDays(e);
      if (w > window) {
        window = w;
      }
    }

    if (lastActivity !== null) {
      const gapDays = Math.trunc((this.now().getTime() - lastActivity.getTime()) / MS_PER_DAY);
      if (gapDays <= window) {
        return [];
      }
      activityDescription += ` (${gapDays} days ago)`;
    }

    let fixesDescription =
      "the automated-security-fixes state could not be observed (endpoint answered 404)";
    if (obs.securityFixes !== null) {
      fixesDescription = `Dependabot security updates: enabled=${Boolean(obs.securityFixes.enabled)}, paused=${Boolean(obs.securityFixes.paused)}`;
    }

    const evidence: Evidence[] = [
      makeEvidence(
        this.now(),
        `GET /repos/${obs.owner}/${obs.name}/contents/${BOT_CONFIG_PATH}`,
        EvidenceMethod.APIRead,
        `dependabot.yml schedules ${obs.config.updates.length} update entries; the most lenient expected-output window is ${window} days (2 intervals + cooldown)`,
        Confidence.Confirmed,
      ),
      makeEvidence(
        this.now(),
        `GET /repos/${obs.owner}/${obs.name}/automated-security-fixes`,
        EvidenceMethod.APIRead,
        fixesDescription,
        Confidence.Confirmed,
      ),
      makeEvidence(
        this.now(),
        `GET /repos/${obs.owner}/${obs.name}/pulls, /repos/${obs.owner}/${obs.name}/commits?author=${DEPENDABOT_LOGIN}`,
        EvidenceMethod.APIRead,
        activityDescription,
        Confidence.Confirmed,
      ),
      makeEvidence(
        this.now(),
        "rule:stall_inference",
        EvidenceMethod.Inference,
        `no bot output within the ${window}-day window suggests scheduled runs are not happening; runs may also have found nothing to update, so this is an estimate, not an observation`,
        Confidence.Inferred,
      ),
    ];

    return [
      {
        type: FindingType.PausedOrStalled,
        subject: { kind: SubjectKind.BotConfig, id: BOT_CONFIG_PATH },
        confidence: weakestLink(evidence),
        detail: "expected Dependabot runs are not observable",
        evidence,
      },
    ];
  }
}
