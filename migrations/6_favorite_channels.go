package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
	"github.com/pocketbase/pocketbase/tools/types"

	"streaming-center-sync/internal/records"
)

// Favourite channels: the ★ a profile keeps before a provider's groups. State
// the app owns, as the subscriptions and playlists of migration 5 are, and so
// built the same way — in a migration of its own, because 5 has shipped.
//
// The key is a generated id; the parents are named in the body, and the hooks
// check each relation is the derived id of the key beside it. The relations
// are not required, because a tombstone carries no data and so no parent; the
// hooks require them of every live record. No number is 0, and no logo empty:
// PocketBase has no null.
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
		connections, err := app.FindCollectionByNameOrId("connections")
		if err != nil {
			return err
		}

		name, _ := records.Collection(records.KindFavoriteChannel)
		owner := types.Pointer("user = @request.auth.id")
		keep := types.Pointer("user = @request.auth.id && (@request.body.user:isset = false || @request.body.user = @request.auth.id)")
		c := core.NewBaseCollection(name)
		c.ListRule, c.ViewRule, c.CreateRule, c.UpdateRule = owner, owner, owner, keep
		c.DeleteRule = nil
		c.Fields.Add(
			&core.RelationField{Name: "user", CollectionId: users.Id, MaxSelect: 1, Required: true, CascadeDelete: true},
			&core.TextField{Name: "key", Required: true, Max: 300},
			&core.BoolField{Name: "deleted"},
			// Cascades only ever run for a deleted account.
			&core.RelationField{Name: "profile", CollectionId: profiles.Id, MaxSelect: 1, CascadeDelete: true},
			&core.RelationField{Name: "connection", CollectionId: connections.Id, MaxSelect: 1, CascadeDelete: true},
			&core.TextField{Name: "profile_key", Max: 128},
			&core.TextField{Name: "connection_key", Max: 128},
			&core.TextField{Name: "external_id", Max: 128},
			&core.TextField{Name: "name", Max: 200},
			&core.NumberField{Name: "number", OnlyInt: true, Min: types.Pointer(0.0)},
			&core.TextField{Name: "logo", Max: 2048},
			&core.TextField{Name: "added_at", Max: 40},
			&core.AutodateField{Name: "created", OnCreate: true},
			&core.AutodateField{Name: "updated", OnCreate: true, OnUpdate: true},
		)
		c.AddIndex("idx_"+name+"_user_key", true, "`user`, `key`", "")
		return app.Save(c)
	}, nil)
}
