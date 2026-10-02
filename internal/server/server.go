// Package server binds this server's rules and routes to a PocketBase app —
// the one main starts, or the one a test starts on a temporary directory.
package server

import (
	"slices"

	"github.com/pocketbase/pocketbase/core"

	"foyer/internal/config"
	"foyer/internal/hooks"
	"foyer/internal/routes"
)

func Bind(app core.App, cfg config.Config) {
	hooks.Register(app, cfg)
	app.OnServe().BindFunc(func(se *core.ServeEvent) error {
		// Never PocketBase's installer: on a server with no superuser it opens a
		// browser tab on whoever started it — one per test in the harness. The
		// first superuser comes from FOYER_ADMIN_EMAIL and FOYER_ADMIN_PASSWORD,
		// or from `superuser upsert`.
		se.InstallerFunc = nil
		if err := trustProxy(se.App, cfg); err != nil {
			return err
		}
		routes.Register(se, cfg)
		return se.Next()
	})
}

// trustProxy applies FOYER_TRUST_PROXY on every start, so `.env` stays the one
// place it is set. Without a proxy nothing is trusted: anyone could send the
// header, and claim any address past the limiter.
func trustProxy(app core.App, cfg config.Config) error {
	want := []string{}
	if cfg.TrustProxy != "" {
		want = []string{cfg.TrustProxy}
	}
	settings := app.Settings()
	if slices.Equal(settings.TrustedProxy.Headers, want) {
		return nil
	}
	settings.TrustedProxy.Headers = want
	return app.Save(settings)
}
