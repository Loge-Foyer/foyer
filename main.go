// Your own server: PocketBase, with the account's collections, rules and hooks.
// PocketBase does most of it — users, sign-in and sessions, the record APIs,
// batches, the dashboard, backups and the rate limiter. This is the rest.
package main

import (
	"log"
	"os"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/plugins/migratecmd"

	"streaming-center-sync/internal/config"
	"streaming-center-sync/internal/invites"
	"streaming-center-sync/internal/server"
	_ "streaming-center-sync/migrations"
)

func main() {
	if err := config.LoadDotEnv(".env"); err != nil {
		log.Fatal(err)
	}
	cfg, err := config.FromEnv(os.Getenv)
	if err != nil {
		log.Fatal(err)
	}

	// Dev mode — which PocketBase turns on by itself under `go run` — prints
	// every SQL statement to stdout, and so buries the one line a script reads
	// from `invite`. It is there for the asking: --dev.
	app := pocketbase.NewWithConfig(pocketbase.Config{DefaultDev: false})
	// The migrations own the collections: none is ever written from the dashboard.
	migratecmd.MustRegister(app, app.RootCmd, migratecmd.Config{Automigrate: false})
	server.Bind(app, cfg)
	app.RootCmd.AddCommand(invites.Command(app))

	if err := app.Start(); err != nil {
		log.Fatal(err)
	}
}
