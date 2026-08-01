package cli_test

import (
	"bytes"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"gopkg.in/dnaeon/go-vcr.v4/pkg/cassette"
	"gopkg.in/dnaeon/go-vcr.v4/pkg/recorder"

	"github.com/necofuryai/depatrol/internal/cli"
)

// scrubbedResponseHeaders describe the recording session rather than the API
// response: the scope set of the token used, the OAuth client it came from,
// the request id, and the edge region that served it. Cassettes are committed
// to a public repository, so none of that belongs in them.
//
// Rate-limit headers are deliberately kept: scan.go turns them into
// github.RateLimitError, and alerts_rate_limited.yaml depends on that.
var scrubbedResponseHeaders = []string{
	"X-Accepted-Oauth-Scopes",
	"X-Github-Edge-Region",
	"X-Github-Request-Id",
	"X-Oauth-Client-Id",
	"X-Oauth-Scopes",
}

// tempCloneToken matches GitHub's temp_clone_token field. It is empty for
// public repositories, but carries a real clone credential otherwise — so it
// is blanked rather than trusted to stay empty.
var tempCloneToken = regexp.MustCompile(`"temp_clone_token":"(?:[^"\\]|\\.)*"`)

const emptyCloneToken = `"temp_clone_token":""`

// scrubInteraction strips credentials and recording-session metadata. It is
// the single definition of "clean" shared by the recorder hook below and
// TestCassettesAreScrubbed.
func scrubInteraction(i *cassette.Interaction) error {
	i.Request.Headers.Del("Authorization")
	for _, header := range scrubbedResponseHeaders {
		i.Response.Headers.Del(header)
	}
	i.Response.Body = tempCloneToken.ReplaceAllString(i.Response.Body, emptyCloneToken)
	return nil
}

// TestRecordRealCassette re-records the recorded_* cassette from the live
// GitHub API, preserving the real API shape that the synthesized
// cassettes only approximate. Run explicitly with:
//
//	DEPATROL_RECORD=1 GITHUB_TOKEN=$(gh auth token) go test ./internal/cli -run TestRecordRealCassette
//
// scrubInteraction cleans each interaction before the cassette is saved.
func TestRecordRealCassette(t *testing.T) {
	if os.Getenv("DEPATROL_RECORD") == "" {
		t.Skip("set DEPATROL_RECORD=1 to re-record the real-repository cassette")
	}
	rec, err := recorder.New("testdata/cassettes/recorded_necofuryai_dev",
		recorder.WithMode(recorder.ModeRecordOnly),
		recorder.WithHook(scrubInteraction, recorder.BeforeSaveHook),
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

// TestCassettesAreScrubbed asserts that every committed cassette is clean.
// TestRecordRealCassette needs a live token and so never runs in CI; this test
// needs none, so a re-recording that reintroduces metadata fails the build
// instead of reaching the public repository.
func TestCassettesAreScrubbed(t *testing.T) {
	paths, err := filepath.Glob(filepath.Join("testdata", "cassettes", "*.yaml"))
	if err != nil {
		t.Fatalf("glob cassettes: %v", err)
	}
	if len(paths) == 0 {
		t.Fatal("no cassettes found under testdata/cassettes")
	}
	for _, path := range paths {
		name := strings.TrimSuffix(path, ".yaml")
		t.Run(filepath.Base(name), func(t *testing.T) {
			c, err := cassette.Load(name)
			if err != nil {
				t.Fatalf("load cassette: %v", err)
			}
			for _, i := range c.Interactions {
				if got := i.Request.Headers.Get("Authorization"); got != "" {
					t.Errorf("interaction %d: Authorization request header present", i.ID)
				}
				for _, header := range scrubbedResponseHeaders {
					if got := i.Response.Headers.Get(header); got != "" {
						t.Errorf("interaction %d: response header %s present: %q", i.ID, header, got)
					}
				}
				if got := tempCloneToken.FindString(i.Response.Body); got != "" && got != emptyCloneToken {
					t.Errorf("interaction %d: non-empty temp_clone_token in response body", i.ID)
				}
			}
		})
	}
}
