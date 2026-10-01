package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
	"github.com/pocketbase/pocketbase/tools/types"

	"streaming-center-sync/internal/records"
)

// Subscriptions and playlists: the first state the app owns itself, as against
// state a media server masters. A channel someone follows, and a list someone
// made — both belong to a profile, and so to the account, and so travel.
//
// Their key is a generated id rather than their parents joined, because the
// id of a channel on a source is the source's and may hold anything. So the
// parents are named in the body (`profile_key`, `connection_key`), and the
// hooks check that each relation is the derived id of the key beside it — a
// device cannot point one account's record at another's profile.
//
// The relations are **not** required: a record created and deleted while
// offline is pushed as a tombstone alone, which carries no data and so no
// parent. The hooks require them of every live record instead.
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

		owner := types.Pointer("user = @request.auth.id")
		keep := types.Pointer("user = @request.auth.id && (@request.body.user:isset = false || @request.body.user = @request.auth.id)")

		collection := func(kind string, fields ...core.Field) *core.Collection {
			name, _ := records.Collection(kind)
			c := core.NewBaseCollection(name)
			c.ListRule, c.ViewRule, c.CreateRule, c.UpdateRule = owner, owner, owner, keep
			c.DeleteRule = nil
			c.Fields.Add(
				&core.RelationField{Name: "user", CollectionId: users.Id, MaxSelect: 1, Required: true, CascadeDelete: true},
				&core.TextField{Name: "key", Required: true, Max: 300},
				&core.BoolField{Name: "deleted"},
			)
			c.Fields.Add(fields...)
			c.Fields.Add(
				&core.AutodateField{Name: "created", OnCreate: true},
				&core.AutodateField{Name: "updated", OnCreate: true, OnUpdate: true},
			)
			c.AddIndex("idx_"+name+"_user_key", true, "`user`, `key`", "")
			return c
		}
		// Cascades only ever run for a deleted account.
		parent := func(name string, of *core.Collection) *core.RelationField {
			return &core.RelationField{Name: name, CollectionId: of.Id, MaxSelect: 1, CascadeDelete: true}
		}
		json := func(name string) *core.JSONField {
			return &core.JSONField{Name: name, MaxSize: records.MaxRecordLength}
		}

		for _, c := range []*core.Collection{
			collection(records.KindSubscription,
				parent("profile", profiles), parent("connection", connections),
				&core.TextField{Name: "profile_key", Max: 128},
				&core.TextField{Name: "connection_key", Max: 128},
				&core.TextField{Name: "external_id", Max: 128},
				&core.TextField{Name: "title", Max: 200},
				&core.TextField{Name: "added_at", Max: 40},
			),
			collection(records.KindPlaylist,
				parent("profile", profiles),
				&core.TextField{Name: "profile_key", Max: 128},
				&core.TextField{Name: "title", Max: 200},
				&core.TextField{Name: "description", Max: 200},
				json("items"), json("source"),
				&core.TextField{Name: "created_at", Max: 40},
				&core.TextField{Name: "updated_at", Max: 40},
			),
		} {
			if err := app.Save(c); err != nil {
				return err
			}
		}
		return nil
	}, nil)
}
