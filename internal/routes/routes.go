// Package routes holds this server's two routes. Everything else a device
// calls is PocketBase's own: signing in, refreshing a session, listing records
// and the batch.
package routes

import (
	"crypto/rand"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"

	"streaming-center-sync/internal/config"
	"streaming-center-sync/internal/invites"
	"streaming-center-sync/internal/records"
)

// Version is what `info` answers as the server's version.
const Version = "0.2.0"

func Register(se *core.ServeEvent, cfg config.Config) {
	// Without a session: the app reads the limit, and whether to offer
	// "Create an account", before anyone signs in.
	se.Router.GET("/api/sc/info", func(e *core.RequestEvent) error {
		return e.JSON(http.StatusOK, map[string]any{
			"serverVersion": Version,
			"maxProfiles":   cfg.MaxProfiles,
			"signUp":        cfg.SignUp,
		})
	})
	se.Router.POST("/api/sc/sign-up", signUp(cfg))
}

type signUpBody struct {
	Username     string `json:"username"`
	Password     string `json:"password"`
	Invite       string `json:"invite"`
	FirstProfile bool   `json:"firstProfile"`
}

var errNoInvite = errors.New("no usable invite")

// signUp makes an account and answers as a sign-in does, so the device is
// signed in at once. One transaction makes the account and its first profile
// and spends the invite: an invite is never spent on an account that was not
// made.
func signUp(cfg config.Config) func(e *core.RequestEvent) error {
	return func(e *core.RequestEvent) error {
		if cfg.SignUp == config.SignUpClosed {
			return e.ForbiddenError("This server takes no new accounts.", nil)
		}
		var body signUpBody
		if err := e.BindBody(&body); err != nil {
			return e.BadRequestError("The sign-up could not be read.", err)
		}

		now := time.Now()
		var account *core.Record
		err := e.App.RunInTransaction(func(tx core.App) error {
			var invite *core.Record
			if cfg.SignUp == config.SignUpInvite {
				// First, so that without an invite nobody learns which usernames exist.
				found, err := invites.Usable(tx, body.Invite, now)
				if err != nil {
					return errNoInvite
				}
				invite = found
			}

			users, err := tx.FindCollectionByNameOrId("users")
			if err != nil {
				return err
			}
			account = core.NewRecord(users)
			account.Set("username", body.Username)
			account.SetPassword(body.Password)
			if err := tx.Save(account); err != nil {
				return err
			}
			if invite != nil {
				if err := invites.Spend(tx, invite, account, now); err != nil {
					return err
				}
			}
			if body.FirstProfile {
				return firstProfile(tx, account, body.Username)
			}
			return nil
		})
		switch {
		case errors.Is(err, errNoInvite):
			return e.ForbiddenError("The invite will not do.", nil)
		case err != nil:
			return e.BadRequestError("The account could not be made.", err)
		}
		return apis.RecordAuthResponse(e, account, core.MFAMethodPassword, nil)
	}
}

// firstProfile is named after the account, under a fresh key and the id a
// device would derive for it — so the first rename lands on this record.
func firstProfile(tx core.App, account *core.Record, name string) error {
	collection, _ := records.Collection(records.KindProfile)
	profiles, err := tx.FindCollectionByNameOrId(collection)
	if err != nil {
		return err
	}
	key, err := uuid()
	if err != nil {
		return err
	}
	profile := core.NewRecord(profiles)
	profile.Set("id", records.ID(account.Id, records.KindProfile, key))
	profile.Set("user", account.Id)
	profile.Set("key", key)
	profile.Set("deleted", false)
	profile.Set("name", name)
	return tx.Save(profile)
}

// uuid is a random version 4 UUID, the shape of the app's own ids.
func uuid() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
}
