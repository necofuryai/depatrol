package scan

import (
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/google/go-github/v89/github"

	"github.com/necofuryai/depatrol/internal/domain"
)

// mergeReevaluationGrace is how long after a merge GitHub's own
// re-evaluation of the default branch is given to resolve the alert
// before an unresolved alert counts as merged_not_effective. Without this
// grace a scan seconds after a merge would produce a false positive.
const mergeReevaluationGrace = 24 * time.Hour

// reviewWaitGraceDays is how long requested reviewers may sit silent
// before that silence counts as a review-wait blocked reason. Fresh PRs
// under branch protection get reviewers requested instantly; flagging
// them immediately would be a false positive.
const reviewWaitGraceDays = 7

// bumpTitle parses Dependabot's single-dependency PR titles, e.g.
// "Bump lodash from 4.17.20 to 4.17.21 in /app", optionally prefixed by a
// configured conventional-commit prefix. Interpreting bot output is
// adapter work (parse, not version resolution). Grouped-update titles do
// not match and are handled as unparsed.
var bumpTitle = regexp.MustCompile(`^(?:\w+(?:\([^)]*\))?:\s*)?[Bb]ump (\S+) from (\S+) to (\S+?)(?: in (\S+))?$`)

type parsedPR struct {
	pr          *github.PullRequest
	dependency  string
	fromVersion string
	toVersion   string
	directory   string // "/" when the title names no directory
}

func parseBumpTitle(pr *github.PullRequest) (parsedPR, bool) {
	m := bumpTitle.FindStringSubmatch(pr.GetTitle())
	if m == nil {
		return parsedPR{}, false
	}
	dir := m[4]
	if dir == "" {
		dir = "/"
	}
	return parsedPR{pr: pr, dependency: m[1], fromVersion: m[2], toVersion: m[3], directory: dir}, true
}

// updateIdentity is the within-repository part of an ExpectedUpdate's
// identity (CONTEXT.md: repository × manifest × dependency — the
// repository component is implicit in a per-repository scan).
type updateIdentity struct{ manifest, dependency string }

func alertIdentity(a *github.DependabotAlert) updateIdentity {
	return updateIdentity{a.GetDependency().GetManifestPath(), a.GetDependency().GetPackage().GetName()}
}

func findOpenBotPR(open []*github.PullRequest, dependency, directory string) *parsedPR {
	for _, pr := range open {
		p, ok := parseBumpTitle(pr)
		if !ok {
			continue
		}
		if p.dependency == dependency && p.directory == directory {
			return &p
		}
	}
	return nil
}

func findMergedBotPR(closed []*github.PullRequest, dependency, directory string) *parsedPR {
	for _, pr := range closed {
		if pr.MergedAt == nil {
			continue
		}
		p, ok := parseBumpTitle(pr)
		if !ok {
			continue
		}
		if p.dependency == dependency && p.directory == directory {
			return &p
		}
	}
	return nil
}

// mergedPREvidence records the observation of a merged Dependabot PR for
// a dependency. Both consumers (merged_not_effective and effective) must
// describe the same observation with the same words.
func (s *Scanner) mergedPREvidence(obs *observation, merged *parsedPR, dependency string) domain.Evidence {
	return s.evidence(
		apiRoute("GET /repos/%s/%s/pulls?state=closed", obs.owner, obs.name),
		domain.MethodParse,
		fmt.Sprintf("Dependabot pull request #%d bumping %s to %s was merged at %s",
			merged.pr.GetNumber(), dependency, merged.toVersion, merged.pr.GetMergedAt().Format(time.RFC3339)),
		domain.Confirmed,
	)
}

// blockedReasons inspects one open PR's detail observations for the three
// blocked reasons M0 can observe directly: failing checks, a merge
// conflict, and a review requesting changes.
func (s *Scanner) blockedReasons(obs *observation, pr *github.PullRequest) (reasons []string, evidence []domain.Evidence) {
	d := obs.prDetails[pr.GetNumber()]
	if d == nil {
		return nil, nil
	}
	for _, c := range d.checks {
		if c.GetStatus() == "completed" && (c.GetConclusion() == "failure" || c.GetConclusion() == "timed_out") {
			reasons = append(reasons, "ci_failing")
			evidence = append(evidence, s.evidence(
				apiRoute("GET /repos/%s/%s/commits/%s/check-runs", obs.owner, obs.name, pr.GetHead().GetSHA()),
				domain.MethodAPIRead,
				fmt.Sprintf("check run %q concluded %s on the head commit of PR #%d", c.GetName(), c.GetConclusion(), pr.GetNumber()),
				domain.Confirmed))
			break
		}
	}
	if d.full != nil && d.full.Mergeable != nil && !d.full.GetMergeable() {
		reasons = append(reasons, "merge_conflict")
		evidence = append(evidence, s.evidence(
			apiRoute("GET /repos/%s/%s/pulls/%d", obs.owner, obs.name, pr.GetNumber()),
			domain.MethodAPIRead,
			fmt.Sprintf("GitHub reports PR #%d as not mergeable (state %q)", pr.GetNumber(), d.full.GetMergeableState()),
			domain.Confirmed))
	}
	latest := map[string]*github.PullRequestReview{}
	for _, r := range d.reviews {
		u := r.GetUser().GetLogin()
		if prev, ok := latest[u]; !ok || r.GetSubmittedAt().Time.After(prev.GetSubmittedAt().Time) {
			latest[u] = r
		}
	}
	for user, r := range latest {
		if r.GetState() == "CHANGES_REQUESTED" {
			reasons = append(reasons, "changes_requested")
			evidence = append(evidence, s.evidence(
				apiRoute("GET /repos/%s/%s/pulls/%d/reviews", obs.owner, obs.name, pr.GetNumber()),
				domain.MethodAPIRead,
				fmt.Sprintf("latest review by %s on PR #%d requests changes", user, pr.GetNumber()),
				domain.Confirmed))
			break
		}
	}
	// review-wait: reviewers were requested long ago and nobody has
	// reviewed at all. Whether the review is *required* cannot be
	// observed with read-only credentials, so the reason is an inference
	// — and it only applies when nothing else explains the stop.
	if len(reasons) == 0 && d.full != nil && len(d.full.RequestedReviewers) > 0 && len(d.reviews) == 0 {
		if ageDays := int(s.now().Sub(pr.GetCreatedAt().Time).Hours() / 24); ageDays > reviewWaitGraceDays {
			reasons = append(reasons, "review_pending")
			evidence = append(evidence,
				s.evidence(
					apiRoute("GET /repos/%s/%s/pulls/%d", obs.owner, obs.name, pr.GetNumber()),
					domain.MethodAPIRead,
					fmt.Sprintf("PR #%d has %d requested reviewer(s), no submitted review, and has been open for %d days", pr.GetNumber(), len(d.full.RequestedReviewers), ageDays),
					domain.Confirmed),
				s.evidence(
					"rule:review_wait_inference",
					domain.MethodInference,
					"prolonged reviewer-requested silence suggests the PR is waiting on review; whether that review is required cannot be observed with read-only credentials",
					domain.Inferred))
		}
	}
	return reasons, evidence
}

// branchNamespaceEcosystem maps Dependabot branch-name namespaces to
// dependabot.yml package-ecosystem vocabulary (adapter parse knowledge).
var branchNamespaceEcosystem = map[string]string{
	"npm_and_yarn":   "npm",
	"go_modules":     "gomod",
	"pip":            "pip",
	"github_actions": "github-actions",
	"docker":         "docker",
	"cargo":          "cargo",
	"bundler":        "bundler",
	"composer":       "composer",
	"maven":          "maven",
	"gradle":         "gradle",
}

// manifestForVersionUpdate resolves a version-update PR to the manifest
// file it targets: the branch name yields the ecosystem, the title yields
// the directory, and the default-branch tree yields the file. When no
// single manifest matches, the directory itself is the identity.
func manifestForVersionUpdate(obs *observation, p parsedPR) string {
	parts := strings.SplitN(p.pr.GetHead().GetRef(), "/", 3)
	if len(parts) >= 2 && parts[0] == "dependabot" {
		if eco := branchNamespaceEcosystem[parts[1]]; eco != "" {
			for _, m := range detectManifests(obs.treePaths) {
				if m.Ecosystem == eco && m.directory() == p.directory {
					return m.Path
				}
			}
		}
	}
	return p.directory
}

// versionUpdates materializes version-update ExpectedUpdates from open
// Dependabot PRs (the second of ADR 0003's sources). PRs already consumed
// by an advisory-linked ExpectedUpdate are skipped. Grouped or otherwise
// unparsable titles are outside M0's parser and yield no ExpectedUpdate.
func (s *Scanner) versionUpdates(obs *observation, used map[int]bool) []domain.ExpectedUpdate {
	pullsRoute := apiRoute("GET /repos/%s/%s/pulls?state=open", obs.owner, obs.name)
	var updates []domain.ExpectedUpdate
	for _, pr := range obs.openPRs {
		if used[pr.GetNumber()] {
			continue
		}
		p, ok := parseBumpTitle(pr)
		if !ok {
			continue
		}
		ageDays := int(s.now().Sub(pr.GetCreatedAt().Time).Hours() / 24)
		evidence := []domain.Evidence{s.evidence(pullsRoute, domain.MethodParse,
			fmt.Sprintf("open Dependabot pull request #%d bumps %s from %s to %s, open for %d days",
				pr.GetNumber(), p.dependency, p.fromVersion, p.toVersion, ageDays),
			domain.Confirmed)}

		state := domain.UpdateOpen
		detail := fmt.Sprintf("open Dependabot PR #%d proposes %s -> %s", pr.GetNumber(), p.fromVersion, p.toVersion)
		reasons, reasonEvidence := s.blockedReasons(obs, pr)
		if len(reasons) > 0 {
			state = domain.Blocked
			detail = fmt.Sprintf("Dependabot PR #%d is stopped: %s", pr.GetNumber(), strings.Join(reasons, ", "))
			evidence = append(evidence, reasonEvidence...)
		}

		updates = append(updates, domain.ExpectedUpdate{
			Manifest:       manifestForVersionUpdate(obs, p),
			Dependency:     p.dependency,
			State:          state,
			BlockedReasons: reasons,
			Detail:         detail,
			Confidence:     domain.WeakestLink(evidence),
			Evidence:       evidence,
		})
	}
	return updates
}

// advisoryUpdates materializes advisory-linked ExpectedUpdates from open
// Dependabot alerts (the first of ADR 0003's three sources). Alerts on the
// same (manifest, dependency) collapse into one ExpectedUpdate carrying
// every advisory ID. The returned set names the open PRs it consumed so
// version-update materialization does not double-count them.
func (s *Scanner) advisoryUpdates(obs *observation) ([]domain.ExpectedUpdate, map[int]bool) {
	grouped := map[updateIdentity][]*github.DependabotAlert{}
	var order []updateIdentity
	for _, a := range obs.openAlerts {
		id := alertIdentity(a)
		if _, ok := grouped[id]; !ok {
			order = append(order, id)
		}
		grouped[id] = append(grouped[id], a)
	}

	alertsRoute := apiRoute("GET /repos/%s/%s/dependabot/alerts?state=open", obs.owner, obs.name)
	pullsRoute := apiRoute("GET /repos/%s/%s/pulls?state=open", obs.owner, obs.name)

	var updates []domain.ExpectedUpdate
	used := map[int]bool{}
	for _, id := range order {
		var advisoryIDs []string
		hasFix := false
		var evidence []domain.Evidence
		for _, a := range grouped[id] {
			ghsa := a.GetSecurityAdvisory().GetGHSAID()
			advisoryIDs = append(advisoryIDs, ghsa)
			desc := fmt.Sprintf("open Dependabot alert #%d (%s, severity %s) on %s in %s",
				a.GetNumber(), ghsa, a.GetSecurityVulnerability().GetSeverity(), id.dependency, id.manifest)
			if patched := a.GetSecurityVulnerability().GetFirstPatchedVersion().GetIdentifier(); patched != "" {
				hasFix = true
				desc += ", first patched version " + patched
			} else {
				desc += ", no patched version released"
			}
			evidence = append(evidence, s.evidence(alertsRoute, domain.MethodAPIRead, desc, domain.Confirmed))
		}

		matched := findOpenBotPR(obs.openPRs, id.dependency, directoryOf(id.manifest))

		var state domain.LifecycleState
		var detail string
		var blocked []string
		switch {
		case !hasFix:
			state = domain.FixUnavailable
			detail = "an advisory is open but no compatible fixed version has been released"
		case matched == nil:
			// No open PR. A merged PR whose alert GitHub has still not
			// resolved means — once the re-evaluation grace has passed —
			// that the merge did not take effect on the current default
			// branch (the product's core check).
			if merged := findMergedBotPR(obs.closedPRs, id.dependency, directoryOf(id.manifest)); merged != nil {
				evidence = append(evidence, s.mergedPREvidence(obs, merged, id.dependency))
				if s.now().Sub(merged.pr.GetMergedAt().Time) > mergeReevaluationGrace {
					state = domain.MergedNotEffective
					detail = fmt.Sprintf("Dependabot PR #%d was merged but the advisory is still open on the current default branch (reverted, or the resolution regressed)", merged.pr.GetNumber())
					evidence = append(evidence, s.evidence(alertsRoute, domain.MethodAPIRead,
						"the alert remains open although GitHub re-evaluates default-branch manifests on push; the fix is not effective",
						domain.Confirmed))
				} else {
					// Inside the grace window the observed merge is
					// acknowledged, never denied: the update sits between
					// merge and GitHub's re-evaluation, which the
					// published vocabulary expresses as pending.
					state = domain.Pending
					detail = fmt.Sprintf("Dependabot PR #%d was merged %dh ago; awaiting GitHub's re-evaluation of the default branch before judging effectiveness",
						merged.pr.GetNumber(), int(s.now().Sub(merged.pr.GetMergedAt().Time).Hours()))
					evidence = append(evidence, s.evidence(alertsRoute, domain.MethodAPIRead,
						"the alert is still open; GitHub's post-merge re-evaluation is given a grace period before judging merged_not_effective",
						domain.Confirmed))
				}
				break
			}
			state = domain.Pending
			detail = "a security fix is available but no Dependabot PR exists yet"
			evidence = append(evidence, s.evidence(pullsRoute, domain.MethodAPIRead,
				fmt.Sprintf("no open Dependabot pull request proposes an update for %s in %s", id.dependency, id.manifest),
				domain.Confirmed))
		default:
			used[matched.pr.GetNumber()] = true
			evidence = append(evidence, s.evidence(pullsRoute, domain.MethodParse,
				fmt.Sprintf("open Dependabot pull request #%d bumps %s to %s", matched.pr.GetNumber(), id.dependency, matched.toVersion),
				domain.Confirmed))
			var reasonEvidence []domain.Evidence
			blocked, reasonEvidence = s.blockedReasons(obs, matched.pr)
			if len(blocked) > 0 {
				state = domain.Blocked
				detail = fmt.Sprintf("Dependabot PR #%d for the security update is stopped: %s",
					matched.pr.GetNumber(), strings.Join(blocked, ", "))
				evidence = append(evidence, reasonEvidence...)
			} else {
				state = domain.UpdateOpen
				detail = fmt.Sprintf("open Dependabot PR #%d proposes %s -> %s",
					matched.pr.GetNumber(), matched.fromVersion, matched.toVersion)
			}
		}

		updates = append(updates, domain.ExpectedUpdate{
			Manifest:       id.manifest,
			Dependency:     id.dependency,
			AdvisoryIDs:    advisoryIDs,
			State:          state,
			BlockedReasons: blocked,
			Detail:         detail,
			Confidence:     domain.WeakestLink(evidence),
			Evidence:       evidence,
		})
	}
	return updates, used
}

// effectiveUpdates materializes terminal-success ExpectedUpdates: a fixed
// alert whose matching Dependabot PR was merged. The alert's resolution is
// GitHub's own re-evaluation of the current default branch, so the state
// is confirmed without any re-scan of depatrol's own (healthy
// repositories get the same evidence treatment as unhealthy ones).
func (s *Scanner) effectiveUpdates(obs *observation) []domain.ExpectedUpdate {
	stillOpen := map[updateIdentity]bool{}
	for _, a := range obs.openAlerts {
		stillOpen[alertIdentity(a)] = true
	}
	alertsRoute := apiRoute("GET /repos/%s/%s/dependabot/alerts?state=fixed", obs.owner, obs.name)
	seen := map[updateIdentity]bool{}
	var updates []domain.ExpectedUpdate
	for _, a := range obs.fixedAlerts {
		id := alertIdentity(a)
		// An identity with another advisory still open is not a success
		// story; the open-alert ExpectedUpdate owns it.
		if seen[id] || stillOpen[id] {
			continue
		}
		seen[id] = true
		merged := findMergedBotPR(obs.closedPRs, id.dependency, directoryOf(id.manifest))
		if merged == nil {
			// Resolved without observable bot work (e.g. a manual bump):
			// there is no bot lifecycle for M0 to report.
			continue
		}
		evidence := []domain.Evidence{
			s.mergedPREvidence(obs, merged, id.dependency),
			s.evidence(alertsRoute, domain.MethodAPIRead,
				fmt.Sprintf("alert #%d (%s) was resolved by GitHub's default-branch re-evaluation at %s",
					a.GetNumber(), a.GetSecurityAdvisory().GetGHSAID(), a.GetFixedAt().Format(time.RFC3339)),
				domain.Confirmed),
		}
		updates = append(updates, domain.ExpectedUpdate{
			Manifest:    id.manifest,
			Dependency:  id.dependency,
			AdvisoryIDs: []string{a.GetSecurityAdvisory().GetGHSAID()},
			State:       domain.Effective,
			Detail: fmt.Sprintf("security update reached the current default branch (alert resolved %s)",
				a.GetFixedAt().Format(time.RFC3339)),
			Confidence: domain.WeakestLink(evidence),
			Evidence:   evidence,
		})
	}
	return updates
}

// deriveVulnerable computes the vulnerable_unpatched findings: an
// advisory-linked ExpectedUpdate that is not effective means the current
// default branch still carries the vulnerability. Derived, never stored.
func (s *Scanner) deriveVulnerable(updates []domain.ExpectedUpdate) []domain.Finding {
	var findings []domain.Finding
	for _, u := range updates {
		if len(u.AdvisoryIDs) == 0 || u.State == domain.Effective {
			continue
		}
		advisories := strings.Join(u.AdvisoryIDs, ", ")
		evidence := []domain.Evidence{{
			Source: "rule:vulnerable_unpatched",
			Method: domain.MethodDerivation,
			Description: fmt.Sprintf(
				"advisory-linked expected update for %s in %s is in state %s, not effective, so the default branch still carries %s",
				u.Dependency, u.Manifest, u.State, advisories),
			Confidence: u.Confidence,
			ObservedAt: s.now(),
		}}
		findings = append(findings, domain.Finding{
			Type:       domain.VulnerableUnpatched,
			Subject:    domain.Subject{Kind: domain.SubjectExpectedUpdate, ID: u.Manifest + ":" + u.Dependency},
			Derived:    true,
			Confidence: u.Confidence,
			Detail:     "unfixed vulnerability remains on the default branch: " + advisories,
			Evidence:   evidence,
		})
	}
	return findings
}
