package main

import (
	"os"
	"runtime/debug"

	"github.com/necofuryai/depatrol/internal/cli"
)

// version, commit, and date match GoReleaser's default ldflags
// (-X main.version={{.Version}} etc.). Builds that skip the injection —
// go install, plain go build — fall back to the module version recorded
// in build info (ADR 0006, docs/runbooks/release.md).
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
			v += ", built " + date
		}
		v += ")"
	}
	return v
}
