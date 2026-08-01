// Package cli wires the depatrol command line. Everything impure is an
// injection point in Options so tests can drive the real pipeline through
// a recorded HTTP transport and a fixed clock — the project's single seam.
package cli

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"

	"github.com/google/go-github/v89/github"
	"github.com/spf13/cobra"

	"github.com/necofuryai/depatrol/internal/scan"
)

// Options carries the injection points. Zero values mean production
// defaults.
type Options struct {
	Transport http.RoundTripper
	Now       func() time.Time
	Out       io.Writer
	Err       io.Writer
}

// Run executes the CLI and returns the process exit code: 0 when a report
// was produced (per-repository scan errors are data, not failures), 1 for
// operational failure, 2 for usage errors.
func Run(args []string, opts Options) int {
	if opts.Transport == nil {
		opts.Transport = http.DefaultTransport
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.Out == nil {
		opts.Out = os.Stdout
	}
	if opts.Err == nil {
		opts.Err = os.Stderr
	}

	root := newRootCmd(opts)
	root.SetArgs(args)
	root.SetOut(opts.Out)
	root.SetErr(opts.Err)
	if err := root.Execute(); err != nil {
		var usage *usageError
		if errors.As(err, &usage) {
			return 2
		}
		return 1
	}
	return 0
}

type usageError struct{ msg string }

func (e *usageError) Error() string { return e.msg }

func newRootCmd(opts Options) *cobra.Command {
	root := &cobra.Command{
		Use:           "depatrol",
		Short:         "Read-only control plane for dependency update bots",
		SilenceUsage:  true,
		SilenceErrors: false,
	}
	root.AddCommand(newScanCmd(opts))
	return root
}

func newScanCmd(opts Options) *cobra.Command {
	var repos []string
	var org string
	var output string

	cmd := &cobra.Command{
		Use:   "scan",
		Short: "Scan repositories and report their state with evidence",
		RunE: func(cmd *cobra.Command, args []string) error {
			if len(repos) == 0 && org == "" {
				return &usageError{"at least one --repo owner/name or an --org is required"}
			}
			if output != "json" && output != "table" {
				return &usageError{fmt.Sprintf("unknown output format %q (json|table)", output)}
			}
			token := os.Getenv("GITHUB_TOKEN")
			if token == "" {
				token = os.Getenv("GH_TOKEN")
			}
			if token == "" {
				return &usageError{"GITHUB_TOKEN (or GH_TOKEN) is not set; depatrol needs a read-only token"}
			}

			client, err := github.NewClient(
				github.WithTransport(opts.Transport),
				github.WithAuthToken(token),
			)
			if err != nil {
				return err
			}

			scanner := scan.New(client, opts.Now)
			targets := repos
			if org != "" {
				orgTargets, err := scanner.ListOrganizationRepositories(cmd.Context(), org)
				if err != nil {
					return fmt.Errorf("listing repositories of %s: %w", org, err)
				}
				targets = append(orgTargets, targets...)
			}

			report := scanner.ScanRepositories(cmd.Context(), targets)

			switch output {
			case "json":
				enc := json.NewEncoder(opts.Out)
				enc.SetIndent("", "  ")
				return enc.Encode(report)
			default:
				return renderTable(opts.Out, report)
			}
		},
	}
	cmd.Flags().StringArrayVar(&repos, "repo", nil, "repository to scan as owner/name (repeatable)")
	cmd.Flags().StringVar(&org, "org", "", "scan every non-archived repository of this organization")
	cmd.Flags().StringVar(&output, "output", "table", "output format: json or table")
	return cmd
}
