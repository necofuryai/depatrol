package cli_test

import (
	"bytes"
	"strings"
	"testing"

	"github.com/necofuryai/depatrol/internal/cli"
)

func TestVersionFlagPrintsInjectedVersion(t *testing.T) {
	var out bytes.Buffer
	code := cli.Run([]string{"--version"}, cli.Options{Version: "1.2.3", Out: &out})
	if code != 0 {
		t.Fatalf("exit code = %d, want 0; output: %s", code, out.String())
	}
	if got := out.String(); !strings.Contains(got, "1.2.3") {
		t.Fatalf("--version output %q does not contain %q", got, "1.2.3")
	}
}

func TestVersionFlagWorksWithoutInjection(t *testing.T) {
	var out bytes.Buffer
	code := cli.Run([]string{"--version"}, cli.Options{Out: &out})
	if code != 0 {
		t.Fatalf("exit code = %d, want 0; output: %s", code, out.String())
	}
	if got := out.String(); !strings.Contains(got, "(devel)") {
		t.Fatalf("--version output %q does not contain fallback %q", got, "(devel)")
	}
}
