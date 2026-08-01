// Package scan orchestrates the read-only observation of repositories and
// turns observations into the domain model's judgments. depatrol never
// resolves versions itself (ADR 0003): everything here consumes what
// GitHub and the bots already expose.
package scan

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/go-github/v89/github"

	"github.com/necofuryai/depatrol/internal/domain"
)

// pageSize caps every list call. M0 reads a single page per source; when a
// repository exceeds this the report is based on the newest page only.
const pageSize = 100

type Scanner struct {
	client *github.Client
	now    func() time.Time
}

func New(client *github.Client, now func() time.Time) *Scanner {
	return &Scanner{client: client, now: now}
}

// observation is everything M0 reads about one repository before judging.
type observation struct {
	owner, name    string
	defaultBranch  string
	treePaths      []string
	treeTruncated  bool
	config         *botConfig // nil when no dependabot.yml exists
	securityFixes  *github.AutomatedSecurityFixes
	openAlerts     []*github.DependabotAlert
	fixedAlerts    []*github.DependabotAlert
	openPRs        []*github.PullRequest // Dependabot-authored only
	closedPRs      []*github.PullRequest // Dependabot-authored only
	prDetails      map[int]*prDetail     // keyed by open PR number
	lastBotCommit  *time.Time            // newest default-branch commit authored by the bot
	alertsDisabled bool                  // Dependabot alerts are disabled for the repository
}

// prDetail is the per-PR observation set needed to explain why an open
// update PR is stopped.
type prDetail struct {
	full    *github.PullRequest // includes mergeable / mergeable_state
	reviews []*github.PullRequestReview
	checks  []*github.CheckRun
}

// ListOrganizationRepositories resolves an organization into scan targets.
// Archived repositories are skipped: update bots do not run on them, so
// scanning them could only produce false stall findings.
func (s *Scanner) ListOrganizationRepositories(ctx context.Context, org string) ([]string, error) {
	opts := &github.RepositoryListByOrgOptions{ListOptions: github.ListOptions{PerPage: pageSize}}
	var targets []string
	for {
		repos, resp, err := s.client.Repositories.ListByOrg(ctx, org, opts)
		if err != nil {
			return nil, err
		}
		for _, r := range repos {
			if r.GetArchived() {
				continue
			}
			targets = append(targets, r.GetFullName())
		}
		if resp.NextPage == 0 {
			return targets, nil
		}
		opts.Page = resp.NextPage
	}
}

// ScanRepositories scans each "owner/name" target. A repository that fails
// mid-fetch becomes a ScanError and the scan continues.
func (s *Scanner) ScanRepositories(ctx context.Context, targets []string) *domain.Report {
	report := &domain.Report{
		ObservedAt:   s.now(),
		Repositories: []domain.RepositoryReport{},
		ScanErrors:   []domain.ScanError{},
	}
	for _, target := range targets {
		owner, name, ok := strings.Cut(target, "/")
		if !ok {
			report.ScanErrors = append(report.ScanErrors, domain.ScanError{
				Repository: target, Stage: "target", Message: "target must be owner/name",
			})
			continue
		}
		rr, stage, err := s.scanRepository(ctx, owner, name)
		if err != nil {
			report.ScanErrors = append(report.ScanErrors, domain.ScanError{
				Repository: target, Stage: stage, Message: err.Error(),
			})
			continue
		}
		report.Repositories = append(report.Repositories, *rr)
	}
	return report
}

func (s *Scanner) scanRepository(ctx context.Context, owner, name string) (*domain.RepositoryReport, string, error) {
	obs, stage, err := s.observe(ctx, owner, name)
	if err != nil {
		return nil, stage, err
	}

	findings := []domain.Finding{}
	updates := []domain.ExpectedUpdate{}

	findings = append(findings, s.judgeCoverage(obs)...)
	findings = append(findings, s.judgePausedOrStalled(obs)...)
	updates = append(updates, s.judgeExpectedUpdates(obs)...)
	findings = append(findings, s.deriveVulnerable(updates)...)

	return &domain.RepositoryReport{
		Repository:      owner + "/" + name,
		DefaultBranch:   obs.defaultBranch,
		Rollup:          domain.ComputeRollup(findings, updates),
		Findings:        findings,
		ExpectedUpdates: updates,
	}, "", nil
}

// observe performs every read for one repository. The stage return value
// names the failing fetch for ScanError reporting.
func (s *Scanner) observe(ctx context.Context, owner, name string) (*observation, string, error) {
	obs := &observation{owner: owner, name: name}

	repo, _, err := s.client.Repositories.Get(ctx, owner, name)
	if err != nil {
		return nil, "repository", err
	}
	obs.defaultBranch = repo.GetDefaultBranch()

	tree, _, err := s.client.Git.GetTree(ctx, owner, name, obs.defaultBranch, true)
	if err != nil {
		return nil, "tree", err
	}
	for _, entry := range tree.Entries {
		if entry.GetType() == "blob" {
			obs.treePaths = append(obs.treePaths, entry.GetPath())
		}
	}
	obs.treeTruncated = tree.GetTruncated()

	obs.config, err = s.fetchBotConfig(ctx, owner, name, obs.defaultBranch)
	if err != nil {
		return nil, "bot_config", err
	}

	fixes, resp, err := s.client.Repositories.GetAutomatedSecurityFixes(ctx, owner, name)
	if err != nil && (resp == nil || resp.StatusCode != 404) {
		return nil, "security_fixes", err
	}
	obs.securityFixes = fixes

	obs.openAlerts, obs.alertsDisabled, err = s.fetchAlerts(ctx, owner, name, "open")
	if err != nil {
		return nil, "alerts_open", err
	}
	if !obs.alertsDisabled {
		obs.fixedAlerts, _, err = s.fetchAlerts(ctx, owner, name, "fixed")
		if err != nil {
			return nil, "alerts_fixed", err
		}
	}

	commits, resp, err := s.client.Repositories.ListCommits(ctx, owner, name, &github.CommitsListOptions{
		Author:      dependabotLogin,
		ListOptions: github.ListOptions{PerPage: 1},
	})
	if err != nil {
		// 409 means the repository has no commits at all.
		if resp == nil || resp.StatusCode != 409 {
			return nil, "commits", err
		}
	} else if len(commits) > 0 {
		t := commits[0].GetCommit().GetCommitter().GetDate().Time
		obs.lastBotCommit = &t
	}

	obs.openPRs, err = s.fetchBotPRs(ctx, owner, name, "open")
	if err != nil {
		return nil, "pulls_open", err
	}
	obs.closedPRs, err = s.fetchBotPRs(ctx, owner, name, "closed")
	if err != nil {
		return nil, "pulls_closed", err
	}

	obs.prDetails = map[int]*prDetail{}
	for _, pr := range obs.openPRs {
		n := pr.GetNumber()
		detail := &prDetail{}
		detail.full, _, err = s.client.PullRequests.Get(ctx, owner, name, n)
		if err != nil {
			return nil, "pull_detail", err
		}
		detail.reviews, _, err = s.client.PullRequests.ListReviews(ctx, owner, name, n,
			&github.ListOptions{PerPage: pageSize})
		if err != nil {
			return nil, "pull_reviews", err
		}
		checks, _, err := s.client.Checks.ListCheckRunsForRef(ctx, owner, name, pr.GetHead().GetSHA(), nil)
		if err != nil {
			return nil, "pull_checks", err
		}
		detail.checks = checks.CheckRuns
		obs.prDetails[n] = detail
	}

	return obs, "", nil
}

// fetchAlerts lists alerts in one state. GitHub answers 403 on this route
// for three different reasons; only "alerts are disabled" is an answer
// rather than a failure, and it must not be conflated with rate limiting
// or a missing token scope — those are scan errors, or a vulnerable
// repository would silently read as healthy.
func (s *Scanner) fetchAlerts(ctx context.Context, owner, name, state string) (alerts []*github.DependabotAlert, disabled bool, err error) {
	alerts, resp, err := s.client.Dependabot.ListRepoAlerts(ctx, owner, name, &github.ListAlertsOptions{
		State:       github.Ptr(state),
		ListOptions: github.ListOptions{PerPage: pageSize},
	})
	if err != nil {
		var rateErr *github.RateLimitError
		var abuseErr *github.AbuseRateLimitError
		if errors.As(err, &rateErr) || errors.As(err, &abuseErr) {
			return nil, false, err
		}
		var ghErr *github.ErrorResponse
		if resp != nil && resp.StatusCode == 403 && errors.As(err, &ghErr) &&
			strings.Contains(strings.ToLower(ghErr.Message), "disabled") {
			return nil, true, nil
		}
		return nil, false, err
	}
	return alerts, false, nil
}

func (s *Scanner) fetchBotPRs(ctx context.Context, owner, name, state string) ([]*github.PullRequest, error) {
	prs, _, err := s.client.PullRequests.List(ctx, owner, name, &github.PullRequestListOptions{
		State:       state,
		ListOptions: github.ListOptions{PerPage: pageSize},
	})
	if err != nil {
		return nil, err
	}
	var bot []*github.PullRequest
	for _, pr := range prs {
		if pr.GetUser().GetLogin() == dependabotLogin {
			bot = append(bot, pr)
		}
	}
	return bot, nil
}

// dependabotLogin is fixed in M0. Configurable bot identity (self-hosted
// Renovate can change its login) is M1's adapter work.
const dependabotLogin = "dependabot[bot]"

func (s *Scanner) evidence(source string, method domain.EvidenceMethod, description string, confidence domain.Confidence) domain.Evidence {
	return domain.Evidence{
		Source:      source,
		Method:      method,
		Description: description,
		Confidence:  confidence,
		ObservedAt:  s.now(),
	}
}

func apiRoute(format string, args ...any) string {
	return fmt.Sprintf(format, args...)
}

// Judgment functions below grow slice by slice.

func (s *Scanner) judgeCoverage(obs *observation) []domain.Finding {
	var findings []domain.Finding
	for _, m := range detectManifests(obs.treePaths) {
		if obs.config != nil && anyEntryCovers(obs.config.Updates, m) {
			continue
		}
		evidence := []domain.Evidence{
			s.evidence(
				apiRoute("GET /repos/%s/%s/git/trees/%s?recursive=1", obs.owner, obs.name, obs.defaultBranch),
				domain.MethodAPIRead,
				fmt.Sprintf("manifest %s (%s) is present on the default branch", m.Path, m.Ecosystem),
				domain.Confirmed,
			),
		}
		if obs.config == nil {
			evidence = append(evidence, s.evidence(
				apiRoute("GET /repos/%s/%s/contents/%s", obs.owner, obs.name, botConfigPath),
				domain.MethodAPIRead,
				"no .github/dependabot.yml exists on the default branch",
				domain.Confirmed,
			))
		} else {
			evidence = append(evidence, s.evidence(
				apiRoute("GET /repos/%s/%s/contents/%s", obs.owner, obs.name, botConfigPath),
				domain.MethodAPIRead,
				fmt.Sprintf(".github/dependabot.yml has no %s entry whose directory covers %s", m.Ecosystem, m.directory()),
				domain.Confirmed,
			))
		}
		findings = append(findings, domain.Finding{
			Type:       domain.CoverageGap,
			Subject:    domain.Subject{Kind: domain.SubjectManifest, ID: m.Path},
			Confidence: domain.WeakestLink(evidence),
			Detail:     fmt.Sprintf("manifest %s (%s) has no covering update-bot configuration", m.Path, m.Ecosystem),
			Evidence:   evidence,
		})
	}
	// A repository with alerts disabled has no security-alert source at
	// all — the security-feature half of coverage_gap's definition.
	if obs.alertsDisabled {
		evidence := []domain.Evidence{s.evidence(
			apiRoute("GET /repos/%s/%s/dependabot/alerts", obs.owner, obs.name),
			domain.MethodAPIRead,
			"the alerts endpoint answered 403 with \"Dependabot alerts are disabled for this repository\"",
			domain.Confirmed,
		)}
		findings = append(findings, domain.Finding{
			Type:       domain.CoverageGap,
			Subject:    domain.Subject{Kind: domain.SubjectBotConfig, ID: "dependabot-alerts"},
			Confidence: domain.WeakestLink(evidence),
			Detail:     "Dependabot alerts are disabled: no security-alert source exists for this repository",
			Evidence:   evidence,
		})
	}
	return findings
}

// intervalDays translates dependabot.yml schedule intervals into days.
// Unrecognized intervals are judged at the most lenient cadence so that a
// config feature M0 does not model can never produce a false stall.
var intervalDays = map[string]int{"daily": 1, "weekly": 7, "monthly": 31}

// entryWindowDays is the expected-output window for one config entry: two
// full schedule intervals plus the configured cooldown. One missed
// interval is normal jitter; missing two while a cooldown cannot explain
// the silence is what the inference calls stalled.
func entryWindowDays(e botConfigEntry) int {
	d, ok := intervalDays[e.Schedule.Interval]
	if !ok {
		d = 31
	}
	return 2*d + e.Cooldown.DefaultDays
}

func (s *Scanner) judgePausedOrStalled(obs *observation) []domain.Finding {
	// paused is a directly observable answer, no inference needed.
	if obs.securityFixes != nil && obs.securityFixes.GetPaused() {
		evidence := []domain.Evidence{s.evidence(
			apiRoute("GET /repos/%s/%s/automated-security-fixes", obs.owner, obs.name),
			domain.MethodAPIRead,
			"Dependabot security updates are paused for this repository",
			domain.Confirmed,
		)}
		return []domain.Finding{{
			Type:       domain.PausedOrStalled,
			Subject:    domain.Subject{Kind: domain.SubjectBotConfig, ID: botConfigPath},
			Confidence: domain.WeakestLink(evidence),
			Detail:     "Dependabot security updates are paused (GitHub pauses after 90 days of untouched PRs or repeated run failures)",
			Evidence:   evidence,
		}}
	}

	// Stall is inferred from schedule + cooldown + observed bot output.
	// Without a config or without manifests nothing is scheduled to run,
	// so there is nothing to infer about.
	if obs.config == nil || len(obs.config.Updates) == 0 || len(detectManifests(obs.treePaths)) == 0 {
		return nil
	}

	// Bot output = PRs plus default-branch commits authored by the bot,
	// whichever is newest. Squash merges keep the bot as commit author, so
	// commits cover activity that PR pruning or renaming would hide.
	var lastPR *github.PullRequest
	for _, pr := range append(append([]*github.PullRequest{}, obs.openPRs...), obs.closedPRs...) {
		if lastPR == nil || pr.GetCreatedAt().Time.After(lastPR.GetCreatedAt().Time) {
			lastPR = pr
		}
	}
	var lastActivity *time.Time
	activityDescription := "no Dependabot pull request or default-branch bot commit is observable (newest 100 open and closed PRs; newest authored commit)"
	if lastPR != nil {
		t := lastPR.GetCreatedAt().Time
		lastActivity = &t
		activityDescription = fmt.Sprintf("newest Dependabot pull request #%d was created %s", lastPR.GetNumber(), t.Format(time.RFC3339))
	}
	if obs.lastBotCommit != nil && (lastActivity == nil || obs.lastBotCommit.After(*lastActivity)) {
		lastActivity = obs.lastBotCommit
		activityDescription = fmt.Sprintf("newest default-branch commit authored by the bot is from %s", obs.lastBotCommit.Format(time.RFC3339))
	}

	window := 0
	for _, e := range obs.config.Updates {
		if w := entryWindowDays(e); w > window {
			window = w
		}
	}
	if lastActivity != nil {
		gapDays := int(s.now().Sub(*lastActivity).Hours() / 24)
		if gapDays <= window {
			return nil
		}
		activityDescription += fmt.Sprintf(" (%d days ago)", gapDays)
	}

	// Describe exactly what the security-fixes endpoint answered — never
	// more. A 404 is itself the observation.
	fixesDescription := "the automated-security-fixes state could not be observed (endpoint answered 404)"
	if obs.securityFixes != nil {
		fixesDescription = fmt.Sprintf("Dependabot security updates: enabled=%t, paused=%t",
			obs.securityFixes.GetEnabled(), obs.securityFixes.GetPaused())
	}

	evidence := []domain.Evidence{
		s.evidence(
			apiRoute("GET /repos/%s/%s/contents/%s", obs.owner, obs.name, botConfigPath),
			domain.MethodAPIRead,
			fmt.Sprintf("dependabot.yml schedules %d update entries; the most lenient expected-output window is %d days (2 intervals + cooldown)", len(obs.config.Updates), window),
			domain.Confirmed,
		),
		s.evidence(
			apiRoute("GET /repos/%s/%s/automated-security-fixes", obs.owner, obs.name),
			domain.MethodAPIRead,
			fixesDescription,
			domain.Confirmed,
		),
		s.evidence(
			apiRoute("GET /repos/%s/%s/pulls, /repos/%s/%s/commits?author=%s", obs.owner, obs.name, obs.owner, obs.name, dependabotLogin),
			domain.MethodAPIRead,
			activityDescription,
			domain.Confirmed,
		),
		s.evidence(
			"rule:stall_inference",
			domain.MethodInference,
			fmt.Sprintf("no bot output within the %d-day window suggests scheduled runs are not happening; runs may also have found nothing to update, so this is an estimate, not an observation", window),
			domain.Inferred,
		),
	}
	return []domain.Finding{{
		Type:       domain.PausedOrStalled,
		Subject:    domain.Subject{Kind: domain.SubjectBotConfig, ID: botConfigPath},
		Confidence: domain.WeakestLink(evidence),
		Detail:     "expected Dependabot runs are not observable",
		Evidence:   evidence,
	}}
}

func (s *Scanner) judgeExpectedUpdates(obs *observation) []domain.ExpectedUpdate {
	advisory, used := s.advisoryUpdates(obs)
	updates := append(advisory, s.versionUpdates(obs, used)...)
	return append(updates, s.effectiveUpdates(obs)...)
}
