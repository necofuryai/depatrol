package main

import (
	"os"

	"github.com/necofuryai/depatrol/internal/cli"
)

func main() {
	os.Exit(cli.Run(os.Args[1:], cli.Options{}))
}
