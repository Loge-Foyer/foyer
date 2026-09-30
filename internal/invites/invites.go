// Package invites makes the codes that let someone create an account, and
// finds one when it is used. The server keeps a code's hash, never the code,
// and an invite is spent on one account.
package invites

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"
	"github.com/spf13/cobra"
)

const Collection = "invites"

// Crockford's base32: no I, L, O or U, so a code read aloud or copied by hand
// survives.
const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

// DefaultValidFor is how long a code lasts unless the command says otherwise.
const DefaultValidFor = 7 * 24 * time.Hour

// ErrUnusable covers every reason alike — unknown, spent, expired — so the
// answer tells nobody which codes exist.
var ErrUnusable = errors.New("the invite will not do")

// New returns a fresh code of 80 random bits, as a person reads it: four
// groups of four.
func New() (string, error) {
	var raw [10]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	var code strings.Builder
	var buffer, bits uint
	for _, b := range raw {
		buffer = buffer<<8 | uint(b)
		bits += 8
		for bits >= 5 {
			bits -= 5
			code.WriteByte(alphabet[(buffer>>bits)&31])
			if code.Len()%5 == 4 && code.Len() < 19 {
				code.WriteByte('-')
			}
		}
	}
	return code.String(), nil
}

// Normalize reads a code however it was typed: case, dashes and spaces do not
// matter, and O, I and L read as 0, 1 and 1.
func Normalize(code string) string {
	var out strings.Builder
	for _, r := range strings.ToUpper(code) {
		switch r {
		case '-', ' ':
			continue
		case 'O':
			r = '0'
		case 'I', 'L':
			r = '1'
		}
		out.WriteRune(r)
	}
	return out.String()
}

// Hash is what the server keeps of a code.
func Hash(code string) string {
	sum := sha256.Sum256([]byte(Normalize(code)))
	return hex.EncodeToString(sum[:])
}

// Create stores a new invite, good for `validFor`, and returns its code.
func Create(app core.App, validFor time.Duration) (string, time.Time, error) {
	collection, err := app.FindCollectionByNameOrId(Collection)
	if err != nil {
		return "", time.Time{}, err
	}
	code, err := New()
	if err != nil {
		return "", time.Time{}, err
	}
	expires := time.Now().Add(validFor).UTC()
	record := core.NewRecord(collection)
	record.Set("code_hash", Hash(code))
	record.Set("expires", expires)
	if err := app.Save(record); err != nil {
		return "", time.Time{}, err
	}
	return code, expires, nil
}

// Usable finds the invite a code names, if nobody has used it and it has not
// expired.
func Usable(app core.App, code string, now time.Time) (*core.Record, error) {
	record, err := app.FindFirstRecordByFilter(Collection, "code_hash = {:hash}", dbx.Params{"hash": Hash(code)})
	if err != nil {
		return nil, ErrUnusable
	}
	if record.GetString("used_by") != "" || !record.GetDateTime("used_at").IsZero() || !now.Before(record.GetDateTime("expires").Time()) {
		return nil, ErrUnusable
	}
	return record, nil
}

// Spend marks an invite used by the account it made, in the caller's
// transaction, so it is never spent on an account that was not made.
func Spend(app core.App, invite *core.Record, account *core.Record, now time.Time) error {
	invite.Set("used_by", account.Id)
	used, err := types.ParseDateTime(now)
	if err != nil {
		return err
	}
	invite.Set("used_at", used)
	return app.Save(invite)
}

// Command is `invite`: it prints a one-time code for creating an account.
func Command(app core.App) *cobra.Command {
	var days int
	command := &cobra.Command{
		Use:          "invite",
		Short:        "Prints a one-time code for creating an account",
		SilenceUsage: true,
		RunE: func(command *cobra.Command, args []string) error {
			if days < 1 {
				return fmt.Errorf("--days must be at least 1")
			}
			// A server that has never been started has no collections yet.
			if err := app.RunAllMigrations(); err != nil {
				return err
			}
			code, expires, err := Create(app, time.Duration(days)*24*time.Hour)
			if err != nil {
				return err
			}
			// The code alone on stdout, so a script can take it; the rest for the person.
			fmt.Fprintln(command.OutOrStdout(), code)
			fmt.Fprintf(command.ErrOrStderr(), "Good for one account, until %s.\n", expires.Format("2 January 2006, 15:04 MST"))
			return nil
		},
	}
	command.Flags().IntVar(&days, "days", int(DefaultValidFor.Hours()/24), "how many days the code lasts")
	return command
}
