// Package domain holds depatrol's two-layer model: coexisting Findings and
// the ExpectedUpdate lifecycle, both backed by Evidence with binary
// confidence. Vocabulary follows CONTEXT.md; structure follows ADR 0005.
package domain

import "time"

// Confidence is binary by decision: confirmed (directly observed) or
// inferred (estimated). No numeric scores.
type Confidence string

const (
	Confirmed Confidence = "confirmed"
	Inferred  Confidence = "inferred"
)

// EvidenceMethod says how an observation was made.
type EvidenceMethod string

const (
	MethodAPIRead    EvidenceMethod = "api_read"   // a field read directly from an API response
	MethodParse      EvidenceMethod = "parse"      // interpreted from bot output (titles, branch names)
	MethodInference  EvidenceMethod = "inference"  // estimated from indirect signals
	MethodDerivation EvidenceMethod = "derivation" // computed from other judgments
)

// Evidence is a single first-class observation backing a judgment.
type Evidence struct {
	// Source identifies where the observation came from, e.g. an API route
	// or the name of an inference rule.
	Source      string         `json:"source"`
	Method      EvidenceMethod `json:"method"`
	Description string         `json:"description"`
	Confidence  Confidence     `json:"confidence"`
	ObservedAt  time.Time      `json:"observed_at"`
}

// WeakestLink derives a judgment's confidence from its evidence: one
// inferred link makes the whole judgment inferred. There is no promotion.
func WeakestLink(evidence []Evidence) Confidence {
	for _, e := range evidence {
		if e.Confidence == Inferred {
			return Inferred
		}
	}
	return Confirmed
}

// SubjectKind names the kinds of things a Finding can be attached to.
type SubjectKind string

const (
	SubjectManifest       SubjectKind = "manifest"
	SubjectBotConfig      SubjectKind = "bot_config"
	SubjectExpectedUpdate SubjectKind = "expected_update"
)

// Subject is what a Finding is attached to.
type Subject struct {
	Kind SubjectKind `json:"kind"`
	ID   string      `json:"id"`
}

type FindingType string

const (
	CoverageGap     FindingType = "coverage_gap"
	PausedOrStalled FindingType = "paused_or_stalled"
	// VulnerableUnpatched is never stored as a primary judgment: it is
	// derived from advisory-linked ExpectedUpdates that are not effective.
	VulnerableUnpatched FindingType = "vulnerable_unpatched"
)

// Finding is a verified observation attached to a subject. Findings
// coexist; they are not exclusive states.
type Finding struct {
	Type       FindingType `json:"type"`
	Subject    Subject     `json:"subject"`
	Derived    bool        `json:"derived,omitempty"`
	Confidence Confidence  `json:"confidence"`
	Detail     string      `json:"detail"`
	Evidence   []Evidence  `json:"evidence"`
}

// LifecycleState is the transition position of an ExpectedUpdate.
type LifecycleState string

const (
	Pending            LifecycleState = "pending"
	UpdateOpen         LifecycleState = "update_open"
	Blocked            LifecycleState = "blocked"
	FixUnavailable     LifecycleState = "fix_unavailable"
	Effective          LifecycleState = "effective"
	MergedNotEffective LifecycleState = "merged_not_effective"
)

// ExpectedUpdate is the fact "dependency X in manifest M should move to a
// safe/newer version", identified by (repository, manifest, dependency).
// PRs and alerts are evidence linked to it, not the entity itself.
type ExpectedUpdate struct {
	Manifest       string         `json:"manifest"`
	Dependency     string         `json:"dependency"`
	AdvisoryIDs    []string       `json:"advisory_ids,omitempty"`
	State          LifecycleState `json:"state"`
	BlockedReasons []string       `json:"blocked_reasons,omitempty"`
	Detail         string         `json:"detail"`
	Confidence     Confidence     `json:"confidence"`
	Evidence       []Evidence     `json:"evidence"`
}

// Rollup labels a repository with its most severe present condition and
// counts every condition. It is always derived, never stored.
type Rollup struct {
	Label  string         `json:"label"`
	Counts map[string]int `json:"counts"`
}

// severityOrder is the published-vocabulary worst-first order from
// CONTEXT.md. Labels outside M0's scope simply never occur yet.
var severityOrder = []string{
	"sla_breached",
	"vulnerable_unpatched",
	"merged_not_effective",
	"fix_unavailable",
	"blocked",
	"paused_or_stalled",
	"coverage_gap",
	"policy_drift",
	"update_open",
	"pending",
}

// ComputeRollup derives the rollup from both layers. `effective` is counted
// (healthy repositories are explained with the same evidence as unhealthy
// ones) but never becomes the label: it is a terminal success state.
func ComputeRollup(findings []Finding, updates []ExpectedUpdate) Rollup {
	counts := map[string]int{}
	for _, f := range findings {
		counts[string(f.Type)]++
	}
	for _, u := range updates {
		counts[string(u.State)]++
	}
	for _, label := range severityOrder {
		if counts[label] > 0 {
			return Rollup{Label: label, Counts: counts}
		}
	}
	return Rollup{Label: "healthy", Counts: counts}
}

// RepositoryReport is one repository's snapshot.
type RepositoryReport struct {
	Repository      string           `json:"repository"`
	DefaultBranch   string           `json:"default_branch"`
	Rollup          Rollup           `json:"rollup"`
	Findings        []Finding        `json:"findings"`
	ExpectedUpdates []ExpectedUpdate `json:"expected_updates"`
}

// ScanError records a repository that could not be scanned. It is not a
// Finding: inability to judge must not be confused with an anomaly.
type ScanError struct {
	Repository string `json:"repository"`
	Stage      string `json:"stage"`
	Message    string `json:"message"`
}

// Target records what the scan was asked to cover, so a repository that
// silently fell out of the scan is detectable from the report alone.
type Target struct {
	Org   string   `json:"org,omitempty"`
	Repos []string `json:"repos,omitempty"`
}

// Report is the stateless snapshot a scan produces. JSON is the primary
// contract; the table output is a projection of this.
type Report struct {
	ObservedAt   time.Time          `json:"observed_at"`
	Target       Target             `json:"target"`
	Repositories []RepositoryReport `json:"repositories"`
	ScanErrors   []ScanError        `json:"scan_errors"`
}
