package cli_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"gopkg.in/dnaeon/go-vcr.v4/pkg/cassette"
	"gopkg.in/dnaeon/go-vcr.v4/pkg/recorder"

	"github.com/necofuryai/depatrol/internal/cli"
)

// fixedNow makes cooldown and age judgments deterministic. Cassette
// timestamps are written relative to this instant.
var fixedNow = time.Date(2026, 8, 1, 12, 0, 0, 0, time.UTC)

// The structs below restate the JSON contract independently of the
// production types on purpose: if the contract drifts, these tests fail.
type reportJSON struct {
	ObservedAt string `json:"observed_at"`
	Target     struct {
		Org   string   `json:"org,omitempty"`
		Repos []string `json:"repos,omitempty"`
	} `json:"target"`
	Repositories []repositoryJSON `json:"repositories"`
	ScanErrors   []scanErrorJSON  `json:"scan_errors"`
}

type repositoryJSON struct {
	Repository      string        `json:"repository"`
	DefaultBranch   string        `json:"default_branch"`
	Rollup          rollupJSON    `json:"rollup"`
	Findings        []findingJSON `json:"findings"`
	ExpectedUpdates []updateJSON  `json:"expected_updates"`
}

type rollupJSON struct {
	Label  string         `json:"label"`
	Counts map[string]int `json:"counts"`
}

type findingJSON struct {
	Type       string         `json:"type"`
	Subject    subjectJSON    `json:"subject"`
	Derived    bool           `json:"derived"`
	Confidence string         `json:"confidence"`
	Detail     string         `json:"detail"`
	Evidence   []evidenceJSON `json:"evidence"`
}

type subjectJSON struct {
	Kind string `json:"kind"`
	ID   string `json:"id"`
}

type updateJSON struct {
	Manifest       string         `json:"manifest"`
	Dependency     string         `json:"dependency"`
	AdvisoryIDs    []string       `json:"advisory_ids"`
	State          string         `json:"state"`
	BlockedReasons []string       `json:"blocked_reasons"`
	Detail         string         `json:"detail"`
	Confidence     string         `json:"confidence"`
	Evidence       []evidenceJSON `json:"evidence"`
}

type evidenceJSON struct {
	Source      string `json:"source"`
	Method      string `json:"method"`
	Description string `json:"description"`
	Confidence  string `json:"confidence"`
	ObservedAt  string `json:"observed_at"`
}

type scanErrorJSON struct {
	Repository string `json:"repository"`
	Stage      string `json:"stage"`
	Message    string `json:"message"`
}

// matchRequest matches on method, host, path and query (order-independent).
// Cassettes are matched on what a request asks for, never on header noise.
func matchRequest(r *http.Request, i cassette.Request) bool {
	if r.Method != i.Method {
		return false
	}
	want, err := url.Parse(i.URL)
	if err != nil {
		return false
	}
	return r.URL.Host == want.Host &&
		r.URL.Path == want.Path &&
		r.URL.Query().Encode() == want.Query().Encode()
}

// runScan drives the real CLI through the project's single seam: a recorded
// HTTP transport and an injected clock.
func runScan(t *testing.T, cassetteName string, args ...string) (string, string, int) {
	t.Helper()
	rec, err := recorder.New("testdata/cassettes/"+cassetteName,
		recorder.WithMode(recorder.ModeReplayOnly),
		recorder.WithMatcher(matchRequest),
	)
	if err != nil {
		t.Fatalf("open cassette: %v", err)
	}
	t.Cleanup(func() {
		if err := rec.Stop(); err != nil {
			t.Errorf("stop recorder: %v", err)
		}
	})
	t.Setenv("GITHUB_TOKEN", "test-token")

	var out, errOut bytes.Buffer
	code := cli.Run(append([]string{"scan"}, args...), cli.Options{
		Transport: rec,
		Now:       func() time.Time { return fixedNow },
		Out:       &out,
		Err:       &errOut,
	})
	return out.String(), errOut.String(), code
}

func scanReport(t *testing.T, cassetteName string, args ...string) reportJSON {
	t.Helper()
	stdout, stderr, code := runScan(t, cassetteName, append(args, "--output", "json")...)
	if code != 0 {
		t.Fatalf("exit code = %d, want 0\nstderr: %s", code, stderr)
	}
	var report reportJSON
	if err := json.Unmarshal([]byte(stdout), &report); err != nil {
		t.Fatalf("output does not follow the JSON contract: %v\n%s", err, stdout)
	}
	return report
}

func singleRepo(t *testing.T, report reportJSON) repositoryJSON {
	t.Helper()
	if len(report.ScanErrors) != 0 {
		t.Fatalf("unexpected scan errors: %+v", report.ScanErrors)
	}
	if len(report.Repositories) != 1 {
		t.Fatalf("got %d repositories, want 1", len(report.Repositories))
	}
	return report.Repositories[0]
}

func requireAllEvidence(t *testing.T, evidence []evidenceJSON, wantConfidence string) {
	t.Helper()
	if len(evidence) == 0 {
		t.Fatal("judgment has no evidence chain")
	}
	for _, e := range evidence {
		if e.Source == "" || e.Method == "" || e.Description == "" {
			t.Errorf("incomplete evidence: %+v", e)
		}
		if wantConfidence != "" && e.Confidence != wantConfidence {
			t.Errorf("evidence confidence = %q, want %q (%s)", e.Confidence, wantConfidence, e.Description)
		}
	}
}

func TestScanReportsCoverageGapForUncoveredManifest(t *testing.T) {
	report := scanReport(t, "coverage_gap", "--repo", "acme/gap")
	repo := singleRepo(t, report)

	if repo.Rollup.Label != "coverage_gap" {
		t.Errorf("rollup label = %q, want coverage_gap", repo.Rollup.Label)
	}
	if repo.Rollup.Counts["coverage_gap"] != 1 {
		t.Errorf("counts = %v, want coverage_gap: 1", repo.Rollup.Counts)
	}
	if len(repo.Findings) != 1 {
		t.Fatalf("findings = %+v, want exactly one", repo.Findings)
	}
	f := repo.Findings[0]
	if f.Type != "coverage_gap" {
		t.Errorf("finding type = %q", f.Type)
	}
	if f.Subject.Kind != "manifest" || f.Subject.ID != "package.json" {
		t.Errorf("subject = %+v, want manifest package.json", f.Subject)
	}
	if f.Confidence != "confirmed" {
		t.Errorf("confidence = %q, want confirmed (both observations are direct API reads)", f.Confidence)
	}
	requireAllEvidence(t, f.Evidence, "confirmed")
}

func TestScanCoveredManifestIsHealthy(t *testing.T) {
	report := scanReport(t, "covered_manifest", "--repo", "acme/covered")
	repo := singleRepo(t, report)

	if repo.Rollup.Label != "healthy" {
		t.Errorf("rollup label = %q, want healthy", repo.Rollup.Label)
	}
	if len(repo.Findings) != 0 {
		t.Errorf("findings = %+v, want none: the npm entry covers package.json", repo.Findings)
	}
}

func findFinding(t *testing.T, repo repositoryJSON, typ string) findingJSON {
	t.Helper()
	for _, f := range repo.Findings {
		if f.Type == typ {
			return f
		}
	}
	t.Fatalf("no %s finding, got %+v", typ, repo.Findings)
	return findingJSON{}
}

func TestScanReportsPausedAsConfirmed(t *testing.T) {
	report := scanReport(t, "paused", "--repo", "acme/paused")
	repo := singleRepo(t, report)

	if repo.Rollup.Label != "paused_or_stalled" {
		t.Errorf("rollup label = %q, want paused_or_stalled", repo.Rollup.Label)
	}
	f := findFinding(t, repo, "paused_or_stalled")
	if f.Subject.Kind != "bot_config" {
		t.Errorf("subject kind = %q, want bot_config", f.Subject.Kind)
	}
	if f.Confidence != "confirmed" {
		t.Errorf("confidence = %q, want confirmed: the paused flag is a direct API read", f.Confidence)
	}
	requireAllEvidence(t, f.Evidence, "confirmed")
}

func TestScanInfersStalledWhenNoBotOutputEverObserved(t *testing.T) {
	report := scanReport(t, "stalled", "--repo", "acme/stalled")
	repo := singleRepo(t, report)

	if repo.Rollup.Label != "paused_or_stalled" {
		t.Errorf("rollup label = %q, want paused_or_stalled", repo.Rollup.Label)
	}
	f := findFinding(t, repo, "paused_or_stalled")
	if f.Confidence != "inferred" {
		t.Errorf("confidence = %q, want inferred: run absence is an estimate, not an observation", f.Confidence)
	}
	requireAllEvidence(t, f.Evidence, "")
	var confirmed, inferred int
	for _, e := range f.Evidence {
		switch e.Confidence {
		case "confirmed":
			confirmed++
		case "inferred":
			inferred++
		}
	}
	if inferred == 0 {
		t.Error("evidence chain must expose the inference link that makes the judgment inferred")
	}
	if confirmed == 0 {
		t.Error("evidence chain must retain the confirmed facts (schedule, paused=false) behind the inference")
	}
}

func TestScanRespectsCooldownWhenJudgingStall(t *testing.T) {
	// 18 days without bot output would look stalled on the face value of a
	// weekly schedule, but the configured 14-day cooldown makes it normal.
	// Flagging this repository is exactly the false positive the founding
	// research warned about (M0 pass criterion 2).
	report := scanReport(t, "cooldown_healthy", "--repo", "acme/cooldown")
	repo := singleRepo(t, report)

	for _, f := range repo.Findings {
		if f.Type == "paused_or_stalled" {
			t.Fatalf("false stall: %+v", f)
		}
	}
	if repo.Rollup.Label != "healthy" {
		t.Errorf("rollup label = %q, want healthy", repo.Rollup.Label)
	}
}

func singleUpdate(t *testing.T, repo repositoryJSON) updateJSON {
	t.Helper()
	if len(repo.ExpectedUpdates) != 1 {
		t.Fatalf("expected_updates = %+v, want exactly one", repo.ExpectedUpdates)
	}
	return repo.ExpectedUpdates[0]
}

func TestScanReportsPendingForAlertWithoutPR(t *testing.T) {
	report := scanReport(t, "alert_pending", "--repo", "acme/vulnpending")
	repo := singleRepo(t, report)

	u := singleUpdate(t, repo)
	if u.Manifest != "package.json" || u.Dependency != "lodash" {
		t.Errorf("identity = (%s, %s), want (package.json, lodash)", u.Manifest, u.Dependency)
	}
	if len(u.AdvisoryIDs) != 1 || u.AdvisoryIDs[0] != "GHSA-aaaa-bbbb-cccc" {
		t.Errorf("advisory_ids = %v", u.AdvisoryIDs)
	}
	if u.State != "pending" {
		t.Errorf("state = %q, want pending: alert exists, bot has not created a PR", u.State)
	}
	if u.Confidence != "confirmed" {
		t.Errorf("confidence = %q, want confirmed", u.Confidence)
	}
	requireAllEvidence(t, u.Evidence, "confirmed")

	derived := findFinding(t, repo, "vulnerable_unpatched")
	if !derived.Derived {
		t.Error("vulnerable_unpatched must be marked derived: it is computed, not stored")
	}
	if repo.Rollup.Label != "vulnerable_unpatched" {
		t.Errorf("rollup label = %q, want vulnerable_unpatched over pending", repo.Rollup.Label)
	}
	if repo.Rollup.Counts["pending"] != 1 || repo.Rollup.Counts["vulnerable_unpatched"] != 1 {
		t.Errorf("counts = %v", repo.Rollup.Counts)
	}
}

func TestScanReportsFixUnavailable(t *testing.T) {
	report := scanReport(t, "fix_unavailable", "--repo", "acme/nofix")
	repo := singleRepo(t, report)

	u := singleUpdate(t, repo)
	if u.Dependency != "leftover" {
		t.Errorf("dependency = %q", u.Dependency)
	}
	if u.State != "fix_unavailable" {
		t.Errorf("state = %q, want fix_unavailable: the advisory has no first patched version", u.State)
	}
	requireAllEvidence(t, u.Evidence, "confirmed")

	findFinding(t, repo, "vulnerable_unpatched")
	if repo.Rollup.Label != "vulnerable_unpatched" {
		t.Errorf("rollup label = %q, want vulnerable_unpatched over fix_unavailable", repo.Rollup.Label)
	}
}

func findUpdate(t *testing.T, repo repositoryJSON, dependency string) updateJSON {
	t.Helper()
	for _, u := range repo.ExpectedUpdates {
		if u.Dependency == dependency {
			return u
		}
	}
	t.Fatalf("no expected update for %s, got %+v", dependency, repo.ExpectedUpdates)
	return updateJSON{}
}

func hasReason(reasons []string, want string) bool {
	for _, r := range reasons {
		if r == want {
			return true
		}
	}
	return false
}

func TestScanReportsVersionUpdateOpen(t *testing.T) {
	report := scanReport(t, "update_open", "--repo", "acme/rolling")
	repo := singleRepo(t, report)

	u := singleUpdate(t, repo)
	if u.Dependency != "axios" {
		t.Errorf("dependency = %q, want axios", u.Dependency)
	}
	if u.Manifest != "package.json" {
		t.Errorf("manifest = %q, want package.json (resolved from branch ecosystem + tree)", u.Manifest)
	}
	if len(u.AdvisoryIDs) != 0 {
		t.Errorf("advisory_ids = %v, want none for a plain version update", u.AdvisoryIDs)
	}
	if u.State != "update_open" {
		t.Errorf("state = %q, want update_open", u.State)
	}
	if u.Confidence != "confirmed" {
		t.Errorf("confidence = %q, want confirmed", u.Confidence)
	}
	requireAllEvidence(t, u.Evidence, "confirmed")
	if repo.Rollup.Label != "update_open" {
		t.Errorf("rollup label = %q, want update_open", repo.Rollup.Label)
	}
}

func TestScanExplainsBlockedPRs(t *testing.T) {
	report := scanReport(t, "blocked", "--repo", "acme/stuck")
	repo := singleRepo(t, report)

	if len(repo.ExpectedUpdates) != 4 {
		t.Fatalf("expected_updates = %+v, want four", repo.ExpectedUpdates)
	}
	cases := []struct{ dep, reason, confidence string }{
		{"ci-dep", "ci_failing", "confirmed"},
		{"conflict-dep", "merge_conflict", "confirmed"},
		{"review-dep", "changes_requested", "confirmed"},
		// wait-dep has reviewers requested for 12 days and no review at
		// all: review-wait is an inference (a required review cannot be
		// observed directly with read-only credentials), so inferred.
		{"wait-dep", "review_pending", "inferred"},
	}
	for _, c := range cases {
		u := findUpdate(t, repo, c.dep)
		if u.State != "blocked" {
			t.Errorf("%s: state = %q, want blocked", c.dep, u.State)
		}
		if !hasReason(u.BlockedReasons, c.reason) {
			t.Errorf("%s: blocked_reasons = %v, want %s", c.dep, u.BlockedReasons, c.reason)
		}
		if u.Confidence != c.confidence {
			t.Errorf("%s: confidence = %q, want %s", c.dep, u.Confidence, c.confidence)
		}
		requireAllEvidence(t, u.Evidence, "")
	}
	if repo.Rollup.Label != "blocked" {
		t.Errorf("rollup label = %q, want blocked", repo.Rollup.Label)
	}
	if repo.Rollup.Counts["blocked"] != 4 {
		t.Errorf("counts = %v, want blocked: 4", repo.Rollup.Counts)
	}
}

func TestScanConfirmsEffectiveSecurityFix(t *testing.T) {
	report := scanReport(t, "effective", "--repo", "acme/fixed")
	repo := singleRepo(t, report)

	u := singleUpdate(t, repo)
	if u.Dependency != "lodash" {
		t.Errorf("dependency = %q", u.Dependency)
	}
	if u.State != "effective" {
		t.Errorf("state = %q, want effective: PR merged and GitHub's re-evaluation resolved the alert", u.State)
	}
	if u.Confidence != "confirmed" {
		t.Errorf("confidence = %q, want confirmed: alert auto-resolution is GitHub's own default-branch re-evaluation", u.Confidence)
	}
	requireAllEvidence(t, u.Evidence, "confirmed")
	if len(u.Evidence) < 2 {
		t.Errorf("evidence = %+v, want both the merge and the alert resolution", u.Evidence)
	}

	for _, f := range repo.Findings {
		if f.Type == "vulnerable_unpatched" {
			t.Errorf("an effective update must not derive vulnerable_unpatched: %+v", f)
		}
	}
	if repo.Rollup.Label != "healthy" {
		t.Errorf("rollup label = %q, want healthy: effective is a success state, never the label", repo.Rollup.Label)
	}
	if repo.Rollup.Counts["effective"] != 1 {
		t.Errorf("counts = %v, want effective: 1 so absorption is visible", repo.Rollup.Counts)
	}
}

func TestScanDetectsMergedNotEffective(t *testing.T) {
	report := scanReport(t, "merged_not_effective", "--repo", "acme/reverted")
	repo := singleRepo(t, report)

	u := singleUpdate(t, repo)
	if u.State != "merged_not_effective" {
		t.Errorf("state = %q, want merged_not_effective: the PR merged days ago yet the alert is still open", u.State)
	}
	if u.Confidence != "confirmed" {
		t.Errorf("confidence = %q, want confirmed", u.Confidence)
	}
	requireAllEvidence(t, u.Evidence, "confirmed")

	derived := findFinding(t, repo, "vulnerable_unpatched")
	if !derived.Derived {
		t.Error("vulnerable_unpatched must be derived")
	}
	if repo.Rollup.Label != "vulnerable_unpatched" {
		t.Errorf("rollup label = %q, want vulnerable_unpatched (severity above merged_not_effective)", repo.Rollup.Label)
	}
	if repo.Rollup.Counts["merged_not_effective"] != 1 {
		t.Errorf("counts = %v, want merged_not_effective: 1", repo.Rollup.Counts)
	}
}

func TestScanContinuesPastBrokenRepository(t *testing.T) {
	report := scanReport(t, "scan_error_continues", "--repo", "acme/broken", "--repo", "acme/empty")

	if len(report.Repositories) != 1 || report.Repositories[0].Repository != "acme/empty" {
		t.Fatalf("repositories = %+v, want only acme/empty", report.Repositories)
	}
	if len(report.ScanErrors) != 1 {
		t.Fatalf("scan_errors = %+v, want exactly one for acme/broken", report.ScanErrors)
	}
	e := report.ScanErrors[0]
	if e.Repository != "acme/broken" || e.Stage != "repository" || e.Message == "" {
		t.Errorf("scan error = %+v, want repository stage with a message", e)
	}
}

func TestScanOrgPaginatesAndSkipsArchivedRepositories(t *testing.T) {
	// The org listing spans two pages (Link header) and includes an
	// archived repository. The cassette holds no interactions for
	// acme/attic (archived): if the scanner tried to scan it, replay-only
	// mode would fail the request. acme/empty2 lives on page 2, so a
	// non-paginating implementation reports only one repository.
	report := scanReport(t, "org_scan", "--org", "acme")

	if report.Target.Org != "acme" {
		t.Errorf("target.org = %q, want acme", report.Target.Org)
	}
	if len(report.ScanErrors) != 0 {
		t.Fatalf("unexpected scan errors: %+v", report.ScanErrors)
	}
	var names []string
	for _, r := range report.Repositories {
		names = append(names, r.Repository)
	}
	if len(names) != 2 || names[0] != "acme/empty" || names[1] != "acme/empty2" {
		t.Errorf("repositories = %v, want [acme/empty acme/empty2]", names)
	}
}

func TestScanReportsAlertsDisabledAsCoverageGap(t *testing.T) {
	report := scanReport(t, "alerts_disabled", "--repo", "acme/noalerts")
	repo := singleRepo(t, report)

	f := findFinding(t, repo, "coverage_gap")
	if f.Subject.Kind != "bot_config" || f.Subject.ID != "dependabot-alerts" {
		t.Errorf("subject = %+v, want bot_config dependabot-alerts", f.Subject)
	}
	if f.Confidence != "confirmed" {
		t.Errorf("confidence = %q, want confirmed: the 403 body names the reason", f.Confidence)
	}
	requireAllEvidence(t, f.Evidence, "confirmed")
	if repo.Rollup.Label != "coverage_gap" {
		t.Errorf("rollup label = %q, want coverage_gap: the security-alert source does not exist", repo.Rollup.Label)
	}
}

func TestScanRateLimit403BecomesScanError(t *testing.T) {
	// A primary rate-limit 403 on the alerts route must not be read as
	// "alerts disabled" and silently produce a healthy repository.
	report := scanReport(t, "alerts_rate_limited", "--repo", "acme/limited")

	if len(report.Repositories) != 0 {
		t.Errorf("repositories = %+v, want none", report.Repositories)
	}
	if len(report.ScanErrors) != 1 {
		t.Fatalf("scan_errors = %+v, want exactly one", report.ScanErrors)
	}
	e := report.ScanErrors[0]
	if e.Repository != "acme/limited" || e.Stage != "alerts_open" {
		t.Errorf("scan error = %+v, want alerts_open stage for acme/limited", e)
	}
}

func TestScanAcknowledgesMergeAwaitingReevaluation(t *testing.T) {
	// The PR merged two hours ago; GitHub's re-evaluation gets a grace
	// period before merged_not_effective. Within it, the judgment must
	// acknowledge the observed merge instead of claiming no PR exists.
	report := scanReport(t, "merged_within_grace", "--repo", "acme/justmerged")
	repo := singleRepo(t, report)

	u := singleUpdate(t, repo)
	if u.State == "merged_not_effective" {
		t.Fatalf("state = merged_not_effective inside the grace window: the false-positive guard is gone")
	}
	if u.State != "pending" {
		t.Errorf("state = %q, want pending (awaiting re-evaluation)", u.State)
	}
	if !strings.Contains(u.Detail, "#95") || !strings.Contains(u.Detail, "merged") {
		t.Errorf("detail = %q, must acknowledge the observed merge of PR #95", u.Detail)
	}
	var mentionsMerge bool
	for _, e := range u.Evidence {
		if strings.Contains(e.Description, "merged") {
			mentionsMerge = true
		}
		if strings.Contains(e.Description, "no open Dependabot pull request") {
			t.Errorf("evidence claims no PR exists although a merge was observed: %q", e.Description)
		}
	}
	if !mentionsMerge {
		t.Error("evidence chain must contain the merged-PR observation")
	}
}

func TestTableOutputProjectsTheReport(t *testing.T) {
	stdout, stderr, code := runScan(t, "healthy_empty", "--repo", "acme/empty")
	if code != 0 {
		t.Fatalf("exit code = %d\nstderr: %s", code, stderr)
	}
	for _, want := range []string{"REPOSITORY", "ROLLUP", "acme/empty", "healthy"} {
		if !strings.Contains(stdout, want) {
			t.Errorf("table output missing %q:\n%s", want, stdout)
		}
	}
	if strings.Contains(stdout, "STATE") {
		t.Errorf("table output uses STATE for the rollup label, which CONTEXT.md reserves for lifecycle positions:\n%s", stdout)
	}
}

func TestUsageErrorsExitTwo(t *testing.T) {
	t.Setenv("GITHUB_TOKEN", "test-token")
	var out, errOut bytes.Buffer
	code := cli.Run([]string{"scan"}, cli.Options{Out: &out, Err: &errOut})
	if code != 2 {
		t.Errorf("exit code = %d, want 2 for a usage error (no --repo/--org)", code)
	}
}

func TestScanRecordedHealthyRepository(t *testing.T) {
	// M0 pass criteria 1 and 2 against a cassette recorded from a real
	// repository (real API shape, credentials scrubbed): no stall false
	// positive on a known-healthy repository, and every judgment carries
	// a complete evidence chain. Re-record via TestRecordRealCassette.
	report := scanReport(t, "recorded_necofuryai_dev", "--repo", "necofuryai/necofuryai.dev")

	if len(report.ScanErrors) != 0 {
		t.Fatalf("scan errors on the recorded healthy repository: %+v", report.ScanErrors)
	}
	if len(report.Repositories) != 1 {
		t.Fatalf("got %d repositories, want 1", len(report.Repositories))
	}
	repo := report.Repositories[0]
	for _, f := range repo.Findings {
		if f.Type == "paused_or_stalled" {
			t.Errorf("false stall on a known-healthy repository (M0 pass criterion 2): %+v", f)
		}
		requireAllEvidence(t, f.Evidence, "")
	}
	for _, u := range repo.ExpectedUpdates {
		requireAllEvidence(t, u.Evidence, "")
	}
}

func TestScanHealthyEmptyRepository(t *testing.T) {
	report := scanReport(t, "healthy_empty", "--repo", "acme/empty")

	if report.ObservedAt != "2026-08-01T12:00:00Z" {
		t.Errorf("observed_at = %q, want the injected clock instant", report.ObservedAt)
	}
	if len(report.Target.Repos) != 1 || report.Target.Repos[0] != "acme/empty" {
		t.Errorf("target.repos = %v, want [acme/empty]", report.Target.Repos)
	}
	repo := singleRepo(t, report)
	if repo.Repository != "acme/empty" {
		t.Errorf("repository = %q, want acme/empty", repo.Repository)
	}
	if repo.DefaultBranch != "main" {
		t.Errorf("default_branch = %q, want main", repo.DefaultBranch)
	}
	if repo.Rollup.Label != "healthy" {
		t.Errorf("rollup label = %q, want healthy", repo.Rollup.Label)
	}
	if len(repo.Findings) != 0 {
		t.Errorf("findings = %+v, want none", repo.Findings)
	}
	if len(repo.ExpectedUpdates) != 0 {
		t.Errorf("expected_updates = %+v, want none", repo.ExpectedUpdates)
	}
}
