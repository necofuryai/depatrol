package scan

import (
	"context"

	"github.com/goccy/go-yaml"
	"github.com/google/go-github/v89/github"
)

const botConfigPath = ".github/dependabot.yml"

// botConfig is the subset of dependabot.yml that M0 interprets.
type botConfig struct {
	Version int              `yaml:"version"`
	Updates []botConfigEntry `yaml:"updates"`
}

type botConfigEntry struct {
	PackageEcosystem string   `yaml:"package-ecosystem"`
	Directory        string   `yaml:"directory"`
	Directories      []string `yaml:"directories"`
	Schedule         struct {
		Interval string `yaml:"interval"`
	} `yaml:"schedule"`
	Cooldown struct {
		DefaultDays int `yaml:"default-days"`
	} `yaml:"cooldown"`
}

// fetchBotConfig reads .github/dependabot.yml from the default branch. A
// missing file is a valid observation (nil config), not an error. M0 only
// reads the .yml spelling.
func (s *Scanner) fetchBotConfig(ctx context.Context, owner, name, branch string) (*botConfig, error) {
	file, _, resp, err := s.client.Repositories.GetContents(ctx, owner, name, botConfigPath,
		&github.RepositoryContentGetOptions{Ref: branch})
	if err != nil {
		if resp != nil && resp.StatusCode == 404 {
			return nil, nil
		}
		return nil, err
	}
	content, err := file.GetContent()
	if err != nil {
		return nil, err
	}
	var cfg botConfig
	if err := yaml.Unmarshal([]byte(content), &cfg); err != nil {
		return nil, err
	}
	return &cfg, nil
}
