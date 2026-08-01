package scan

import (
	"path"
	"strings"
)

// manifest is a dependency manifest observed on the default branch.
type manifest struct {
	Path      string
	Ecosystem string // dependabot.yml package-ecosystem vocabulary
}

// manifestBaseNames maps well-known manifest base names to the
// package-ecosystem vocabulary of dependabot.yml. Recognizing a file name
// is observation interpretation, not version resolution (ADR 0003).
var manifestBaseNames = map[string]string{
	"package.json":     "npm",
	"go.mod":           "gomod",
	"requirements.txt": "pip",
	"pyproject.toml":   "pip",
	"Pipfile":          "pip",
	"Gemfile":          "bundler",
	"Cargo.toml":       "cargo",
	"composer.json":    "composer",
	"pom.xml":          "maven",
	"build.gradle":     "gradle",
	"build.gradle.kts": "gradle",
	"Dockerfile":       "docker",
}

func detectManifests(paths []string) []manifest {
	var out []manifest
	for _, p := range paths {
		if eco, ok := manifestBaseNames[path.Base(p)]; ok {
			out = append(out, manifest{Path: p, Ecosystem: eco})
			continue
		}
		if strings.HasPrefix(p, ".github/workflows/") &&
			(strings.HasSuffix(p, ".yml") || strings.HasSuffix(p, ".yaml")) {
			out = append(out, manifest{Path: p, Ecosystem: "github-actions"})
		}
	}
	return out
}

// directoryOf maps a file path to the shared directory vocabulary used by
// dependabot.yml entries, PR titles, and alert manifest paths: "/" for the
// repository root, "/sub/dir" otherwise. Config-coverage matching and
// alert-to-PR matching must agree on this, so there is exactly one copy.
func directoryOf(p string) string {
	dir := path.Dir(p)
	if dir == "." {
		return "/"
	}
	return "/" + dir
}

// directory returns the dependabot.yml directory that would cover this
// manifest. Workflow files are covered by a github-actions entry with
// directory "/" by Dependabot convention.
func (m manifest) directory() string {
	if m.Ecosystem == "github-actions" {
		return "/"
	}
	return directoryOf(m.Path)
}

// covers reports whether the entry covers the manifest: same ecosystem and
// an exactly matching directory. Glob directory matching is outside M0.
func (e botConfigEntry) covers(m manifest) bool {
	if e.PackageEcosystem != m.Ecosystem {
		return false
	}
	if e.Directory != "" && path.Clean(e.Directory) == m.directory() {
		return true
	}
	for _, d := range e.Directories {
		if path.Clean(d) == m.directory() {
			return true
		}
	}
	return false
}

func anyEntryCovers(entries []botConfigEntry, m manifest) bool {
	for _, e := range entries {
		if e.covers(m) {
			return true
		}
	}
	return false
}
