package cli

import (
	"fmt"
	"io"
	"sort"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/necofuryai/depatrol/internal/domain"
)

// renderTable projects the report for humans. The JSON output is the
// primary contract; this view adds no information of its own.
func renderTable(w io.Writer, report *domain.Report) error {
	tw := tabwriter.NewWriter(w, 0, 4, 2, ' ', 0)
	// The column is the rollup label, never "state": CONTEXT.md reserves
	// state for lifecycle positions. Scan errors are listed apart — the
	// inability to judge must not read like a judged condition.
	fmt.Fprintln(tw, "REPOSITORY\tROLLUP\tCONDITIONS")
	for _, r := range report.Repositories {
		fmt.Fprintf(tw, "%s\t%s\t%s\n", r.Repository, r.Rollup.Label, formatCounts(r.Rollup.Counts))
	}
	renderJudgments(tw, report)
	if len(report.ScanErrors) > 0 {
		fmt.Fprintln(tw, "\nSCAN ERRORS")
		for _, e := range report.ScanErrors {
			fmt.Fprintf(tw, "%s\t%s\t%s\n", e.Repository, e.Stage, e.Message)
		}
	}
	return tw.Flush()
}

func renderJudgments(tw *tabwriter.Writer, report *domain.Report) {
	hasJudgments := false
	for _, r := range report.Repositories {
		if len(r.Findings) > 0 || len(r.ExpectedUpdates) > 0 {
			hasJudgments = true
			break
		}
	}
	if !hasJudgments {
		return
	}

	fmt.Fprintln(tw, "\nJUDGMENTS")
	fmt.Fprintln(tw, "REPOSITORY\tKIND\tCONDITION\tSUBJECT\tCONFIDENCE\tPR AGE\tDETAIL")
	for _, r := range report.Repositories {
		for _, f := range r.Findings {
			fmt.Fprintf(tw, "%s\tfinding\t%s\t%s:%s\t%s\t-\t%s\n",
				r.Repository, f.Type, f.Subject.Kind, f.Subject.ID, f.Confidence, f.Detail)
		}
		for _, u := range r.ExpectedUpdates {
			age := "-"
			if u.PRAgeDays != nil {
				age = fmt.Sprintf("%dd", *u.PRAgeDays)
			}
			fmt.Fprintf(tw, "%s\texpected_update\t%s\t%s:%s\t%s\t%s\t%s\n",
				r.Repository, u.State, u.Manifest, u.Dependency, u.Confidence, age, u.Detail)
		}
	}

	fmt.Fprintln(tw, "\nEVIDENCE")
	fmt.Fprintln(tw, "REPOSITORY\tKIND\tCONDITION\tSUBJECT\t#\tMETHOD\tCONFIDENCE\tOBSERVED AT\tSOURCE\tDESCRIPTION")
	for _, r := range report.Repositories {
		for _, f := range r.Findings {
			renderEvidenceRows(tw, r.Repository, "finding", string(f.Type), string(f.Subject.Kind)+":"+f.Subject.ID, f.Evidence)
		}
		for _, u := range r.ExpectedUpdates {
			renderEvidenceRows(tw, r.Repository, "expected_update", string(u.State), u.Manifest+":"+u.Dependency, u.Evidence)
		}
	}
}

func renderEvidenceRows(tw *tabwriter.Writer, repository, kind, condition, subject string, evidence []domain.Evidence) {
	for i, e := range evidence {
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%d\t%s\t%s\t%s\t%s\t%s\n",
			repository, kind, condition, subject, i+1, e.Method, e.Confidence,
			e.ObservedAt.Format(time.RFC3339), e.Source, e.Description)
	}
}

func formatCounts(counts map[string]int) string {
	if len(counts) == 0 {
		return "-"
	}
	keys := make([]string, 0, len(counts))
	for k := range counts {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, fmt.Sprintf("%s:%d", k, counts[k]))
	}
	return strings.Join(parts, " ")
}
