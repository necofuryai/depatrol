package cli

import (
	"fmt"
	"io"
	"sort"
	"strings"
	"text/tabwriter"

	"github.com/necofuryai/depatrol/internal/domain"
)

// renderTable projects the report for humans. The JSON output is the
// primary contract; this view adds no information of its own.
func renderTable(w io.Writer, report *domain.Report) error {
	tw := tabwriter.NewWriter(w, 0, 4, 2, ' ', 0)
	fmt.Fprintln(tw, "REPOSITORY\tSTATE\tCONDITIONS")
	for _, r := range report.Repositories {
		fmt.Fprintf(tw, "%s\t%s\t%s\n", r.Repository, r.Rollup.Label, formatCounts(r.Rollup.Counts))
	}
	for _, e := range report.ScanErrors {
		fmt.Fprintf(tw, "%s\tscan_error\t%s: %s\n", e.Repository, e.Stage, e.Message)
	}
	return tw.Flush()
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
