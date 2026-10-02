// Package migrations sets PocketBase up for the account: its collections and
// their rules, the users collection, the settings the app needs, and the
// first superuser. Numbered, and never edited once shipped: a server that ran
// one never runs it again, so a change is a new one. Automigrate stays off,
// and nobody changes the collections in the dashboard.
package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
	"github.com/pocketbase/pocketbase/tools/types"

	"foyer/internal/records"
)

// The account's five collections, and the invites.
//
// Every data record carries its account (`user`), its key, and whether it is
// deleted; a child points at its parents too, so a batch sends parents first.
// The data fields are all optional to PocketBase: a tombstone has none, and
// the hooks judge a live record the way the api does.
func init() {
	m.Register(func(app core.App) error {
		users, err := app.FindCollectionByNameOrId("users")
		if err != nil {
			return err
		}

		owner := types.Pointer("user = @request.auth.id")
		// An update never moves a record to another account.
		keep := types.Pointer("user = @request.auth.id && (@request.body.user:isset = false || @request.body.user = @request.auth.id)")

		collection := func(kind string, fields ...core.Field) *core.Collection {
			name, _ := records.Collection(kind)
			c := core.NewBaseCollection(name)
			c.ListRule, c.ViewRule, c.CreateRule, c.UpdateRule = owner, owner, owner, keep
			// Superusers only, and the hooks refuse them too: a record removed
			// by hand reads as lost, and the devices bring it back.
			c.DeleteRule = nil
			c.Fields.Add(
				&core.RelationField{Name: "user", CollectionId: users.Id, MaxSelect: 1, Required: true, CascadeDelete: true},
				&core.TextField{Name: "key", Required: true, Max: 300},
				&core.BoolField{Name: "deleted"},
			)
			c.Fields.Add(fields...)
			// For people reading the dashboard. Nothing decides by them.
			c.Fields.Add(
				&core.AutodateField{Name: "created", OnCreate: true},
				&core.AutodateField{Name: "updated", OnCreate: true, OnUpdate: true},
			)
			c.AddIndex("idx_"+name+"_user_key", true, "`user`, `key`", "")
			return c
		}
		parent := func(name string, of *core.Collection) *core.RelationField {
			// Cascades only ever run for a deleted account: nothing else is removed.
			return &core.RelationField{Name: name, CollectionId: of.Id, MaxSelect: 1, Required: true, CascadeDelete: true}
		}
		json := func(name string) *core.JSONField {
			return &core.JSONField{Name: name, MaxSize: records.MaxRecordLength}
		}

		profiles := collection(records.KindProfile, &core.TextField{Name: "name", Max: 200})
		if err := app.Save(profiles); err != nil {
			return err
		}
		connections := collection(records.KindConnection,
			&core.TextField{Name: "plugin_id", Max: 200},
			&core.TextField{Name: "label", Max: 200},
			&core.BoolField{Name: "enabled"},
			&core.TextField{Name: "per_profile", Max: 20},
			json("fields"), json("settings"), json("secret_keys"),
			// Source and IPTV passwords, in plain text, for now.
			json("secrets"),
		)
		if err := app.Save(connections); err != nil {
			return err
		}
		for _, c := range []*core.Collection{
			collection(records.KindPin, parent("profile", profiles), &core.TextField{Name: "pin", Max: 4}),
			collection(records.KindPreference, parent("profile", profiles), &core.TextField{Name: "name", Max: 128}, json("value")),
			collection(records.KindProfileValues,
				parent("connection", connections), parent("profile", profiles),
				&core.BoolField{Name: "off"},
				json("fields"), json("settings"), json("secret_keys"), json("secrets"),
			),
		} {
			if err := app.Save(c); err != nil {
				return err
			}
		}

		// Superusers only. A code is kept as its hash, and spent on one account.
		invites := core.NewBaseCollection("invites")
		invites.Fields.Add(
			&core.TextField{Name: "code_hash", Required: true, Hidden: true, Max: 64},
			&core.DateField{Name: "expires", Required: true},
			&core.RelationField{Name: "used_by", CollectionId: users.Id, MaxSelect: 1},
			&core.DateField{Name: "used_at"},
			&core.AutodateField{Name: "created", OnCreate: true},
		)
		invites.AddIndex("idx_invites_code_hash", true, "`code_hash`", "")
		return app.Save(invites)
	}, nil)
}
