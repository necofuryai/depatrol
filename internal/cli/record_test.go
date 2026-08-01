package cli_test

import (
	"bytes"
	"os"
	"testing"
	"time"

	"gopkg.in/dnaeon/go-vcr.v4/pkg/cassette"
	"gopkg.in/dnaeon/go-vcr.v4/pkg/recorder"

	"github.com/necofuryai/depatrol/internal/cli"
)

// TestRecordRealCassette re-records the recorded_* cassette from the live
// GitHub API, preserving the real API shape that the synthesized
// cassettes only approximate. Run explicitly with:
//
//	DEPATROL_RECORD=1 GITHUB_TOKEN=$(gh auth token) go test ./internal/cli -run TestRecordRealCassette
//
// Credentials are scrubbed before the cassette is saved.
func TestRecordRealCassette(t *testing.T) {
	if os.Getenv("DEPATROL_RECORD") == "" {
		t.Skip("set DEPATROL_RECORD=1 to re-record the real-repository cassette")
	}
	rec, err := recorder.New("testdata/cassettes/recorded_necofuryai_dev",
		recorder.WithMode(recorder.ModeRecordOnly),
		recorder.WithHook(func(i *cassette.Interaction) error {
			i.Request.Headers.Del("Authorization")
			return nil
		}, recorder.BeforeSaveHook),
	)
	if err != nil {
		t.Fatalf("open recorder: %v", err)
	}

	var out, errOut bytes.Buffer
	code := cli.Run(
		[]string{"scan", "--repo", "necofuryai/necofuryai.dev", "--output", "json"},
		cli.Options{Transport: rec, Now: time.Now, Out: &out, Err: &errOut},
	)
	if stopErr := rec.Stop(); stopErr != nil {
		t.Fatalf("save cassette: %v", stopErr)
	}
	if code != 0 {
		t.Fatalf("recording scan failed with exit code %d\nstderr: %s", code, errOut.String())
	}
	t.Logf("recorded output:\n%s", out.String())
}
