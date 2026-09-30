package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
	"github.com/pocketbase/pocketbase/tools/types"
)

// Sessions last 30 days, and every sync refreshes them.
const sessionSeconds = 30 * 24 * 60 * 60

// PocketBase's users are the accounts: a username and a password, nothing
// else. Nobody registers through PocketBase's own route — accounts come from
// the sign-up route, which checks the invite — and only a superuser changes
// or deletes one.
func init() {
	m.Register(func(app core.App) error {
		users, err := app.FindCollectionByNameOrId("users")
		if err != nil {
			return err
		}

		users.Fields.RemoveByName("name")
		users.Fields.RemoveByName("avatar")
		users.Fields.Add(&core.TextField{
			Name:     "username",
			Required: true,
			Min:      3,
			Max:      50,
			Pattern:  `^[A-Za-z0-9][A-Za-z0-9._-]*$`,
		})
		// NOCASE makes PocketBase's sign-in compare the name without regard to case, too.
		users.AddIndex("idx_users_username", true, "`username` COLLATE NOCASE", "")
		if email, ok := users.Fields.GetByName(core.FieldNameEmail).(*core.EmailField); ok {
			email.Required = false
		}

		users.PasswordAuth.Enabled = true
		users.PasswordAuth.IdentityFields = []string{"username"}
		users.OAuth2.Enabled = false
		users.OAuth2.MappedFields = core.OAuth2KnownFields{}
		users.OTP.Enabled = false
		users.MFA.Enabled = false
		// It mails about a sign-in from a new device, and the server sends no mail.
		users.AuthAlert.Enabled = false
		users.AuthToken.Duration = sessionSeconds

		self := types.Pointer("id = @request.auth.id")
		users.ListRule, users.ViewRule = self, self
		users.CreateRule, users.UpdateRule, users.DeleteRule = nil, nil, nil

		return app.Save(users)
	}, nil)
}
