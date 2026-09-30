package migrations

import (
	"os"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"

	"streaming-center-sync/internal/config"
)

// The first superuser, from SC_ADMIN_EMAIL and SC_ADMIN_PASSWORD, when the
// server starts for the first time with them set. Without them, `superuser
// upsert` makes one. Either way the password should not stay in `.env`.
func init() {
	m.Register(func(app core.App) error {
		cfg, err := config.FromEnv(os.Getenv)
		if err != nil || cfg.AdminEmail == "" {
			return err
		}
		superusers, err := app.FindCollectionByNameOrId(core.CollectionNameSuperusers)
		if err != nil {
			return err
		}
		if total, err := app.CountRecords(superusers); err != nil || total > 0 {
			return err
		}
		record := core.NewRecord(superusers)
		record.SetEmail(cfg.AdminEmail)
		record.SetPassword(cfg.AdminPassword)
		return app.Save(record)
	}, nil)
}
