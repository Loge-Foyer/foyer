package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
	"github.com/pocketbase/pocketbase/tools/types"

	"streaming-center-sync/internal/records"
)

// Watch progress the app keeps, for sources that keep none — IPTV films and
// series, web video, plain files — and the account's own settings, which say
// on which tabs it keeps it. State the app owns, as the lists of migrations 5
// and 6 are, in a migration of its own because those have shipped.
//
// A watch record's key is its profile and a hash of what was watched, so its
// profile comes from the key, as a preference's does. The client merges what
// two devices kept, field by field; the server stores what it is sent and
// returns it. PocketBase has no null: no position or duration is 0, no
// catalogue ids and no snapshot `{}`.
func init() {
	m.Register(func(app core.App) error {
		users, err := app.FindCollectionByNameOrId("users")
		if err != nil {
			return err
		}
		profiles, err := app.FindCollectionByNameOrId("profiles")
		if err != nil {
			return err
		}
		owner := types.Pointer("user = @request.auth.id")
		keep := types.Pointer("user = @request.auth.id && (@request.body.user:isset = false || @request.body.user = @request.auth.id)")
		account := func(name string) *core.Collection {
			c := core.NewBaseCollection(name)
			c.ListRule, c.ViewRule, c.CreateRule, c.UpdateRule = owner, owner, owner, keep
			c.DeleteRule = nil
			return c
		}

		progressName, _ := records.Collection(records.KindWatchProgress)
		progress := account(progressName)
		progress.Fields.Add(
			&core.RelationField{Name: "user", CollectionId: users.Id, MaxSelect: 1, Required: true, CascadeDelete: true},
			&core.TextField{Name: "key", Required: true, Max: 300},
			&core.BoolField{Name: "deleted"},
			// Cascades only ever run for a deleted account.
			&core.RelationField{Name: "profile", CollectionId: profiles.Id, MaxSelect: 1, CascadeDelete: true},
			&core.TextField{Name: "identity", Max: 300},
			&core.JSONField{Name: "external_ids", MaxSize: records.MaxRecordLength},
			&core.NumberField{Name: "round", OnlyInt: true, Min: types.Pointer(0.0)},
			&core.BoolField{Name: "watched"},
			&core.NumberField{Name: "position_ms", OnlyInt: true, Min: types.Pointer(0.0)},
			&core.NumberField{Name: "duration_ms", OnlyInt: true, Min: types.Pointer(0.0)},
			&core.JSONField{Name: "item", MaxSize: records.MaxRecordLength},
			&core.TextField{Name: "created_at", Max: 40},
			&core.TextField{Name: "updated_at", Max: 40},
			&core.AutodateField{Name: "created", OnCreate: true},
			&core.AutodateField{Name: "updated", OnCreate: true, OnUpdate: true},
		)
		progress.AddIndex("idx_"+progressName+"_user_key", true, "`user`, `key`", "")
		if err := app.Save(progress); err != nil {
			return err
		}

		settingsName, _ := records.Collection(records.KindSetting)
		settings := account(settingsName)
		settings.Fields.Add(
			&core.RelationField{Name: "user", CollectionId: users.Id, MaxSelect: 1, Required: true, CascadeDelete: true},
			&core.TextField{Name: "key", Required: true, Max: 128},
			&core.BoolField{Name: "deleted"},
			&core.JSONField{Name: "value", MaxSize: records.MaxRecordLength},
			&core.AutodateField{Name: "created", OnCreate: true},
			&core.AutodateField{Name: "updated", OnCreate: true, OnUpdate: true},
		)
		settings.AddIndex("idx_"+settingsName+"_user_key", true, "`user`, `key`", "")
		return app.Save(settings)
	}, nil)
}
