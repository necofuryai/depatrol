package main

import (
	"os"
	"runtime/debug"

	"github.com/necofuryai/depatrol/internal/cli"
)

// version, commit, and date match the deterministic GoReleaser ldflags.
// Builds that skip the injection — go install, plain go build — fall back
// to the module version recorded in build info (ADR 0006 and the release
// runbook).
var (
	version = ""
	commit  = ""
	date    = ""
)

func main() {
	os.Exit(cli.Run(os.Args[1:], cli.Options{Version: buildVersion()}))
}

func buildVersion() string {
	v := version
	if v == "" {
		if info, ok := debug.ReadBuildInfo(); ok && info.Main.Version != "" {
			v = info.Main.Version
		} else {
			v = "(devel)"
		}
	}
	if commit != "" {
		v += " (commit " + commit
		if date != "" {
			v += ", commit date " + date
		}
		v += ")"
	}
	return v
}
