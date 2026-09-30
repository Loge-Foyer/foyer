package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

// The batch API, on and with room for the largest push: a whole local account
// uploaded at sign-up. PocketBase's defaults — off, 50 requests, 3 seconds —
// would fail it without naming a write, which a device cannot act on.
//
// And the rate limiter. It counts per address, never per account, so nobody
// who knows a username can keep its owner out. A batch's writes each pass it,
// so creates and updates have rules of their own, generous ones: without them
// they would fall to the catch-all and fail a large upload half-way.
func init() {
	m.Register(func(app core.App) error {
		settings := app.Settings()
		settings.Meta.AppName = "Streaming Center"
		settings.Batch = core.BatchConfig{Enabled: true, MaxRequests: 1000, Timeout: 30, MaxBodySize: 32 << 20}
		settings.RateLimits.Enabled = true
		settings.RateLimits.Rules = []core.RateLimitRule{
			// Signing in and the owner check: guessing a password gets nowhere.
			{Label: "*:authWithPassword", MaxRequests: 5, Duration: 60},
			{Label: "/api/sc/sign-up", MaxRequests: 5, Duration: 60},
			{Label: "*:authRefresh", MaxRequests: 60, Duration: 60},
			{Label: "*:create", MaxRequests: 5000, Duration: 60},
			{Label: "*:update", MaxRequests: 5000, Duration: 60},
			{Label: "/api/batch", MaxRequests: 30, Duration: 60},
			{Label: "/api/", MaxRequests: 300, Duration: 10},
		}
		return app.Save(settings)
	}, nil)
}
