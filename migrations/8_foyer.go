package migrations

import (
	"slices"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

// The server became Foyer, and its sign-up route moved with it. Migration 3
// named both the old way and is never edited, so this carries them forward:
// the dashboard's name, and the sign-up rule's label — left behind, sign-up
// would fall to the catch-all and lose its throttle. A rule an operator already
// made for the new route stands, and the old one goes: PocketBase refuses two
// rules for one label.
func init() {
	m.Register(func(app core.App) error {
		settings := app.Settings()
		settings.Meta.AppName = "Foyer"
		taken := slices.ContainsFunc(settings.RateLimits.Rules, func(rule core.RateLimitRule) bool {
			return rule.Label == "/api/foyer/sign-up"
		})
		rules := make([]core.RateLimitRule, 0, len(settings.RateLimits.Rules))
		for _, rule := range settings.RateLimits.Rules {
			if rule.Label == "/api/sc/sign-up" {
				if taken {
					continue
				}
				rule.Label = "/api/foyer/sign-up"
			}
			rules = append(rules, rule)
		}
		settings.RateLimits.Rules = rules
		return app.Save(settings)
	}, nil)
}
