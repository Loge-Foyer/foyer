// Package hooks holds the account's rules that PocketBase's own cannot state:
// no guests on account data, every write judged the way the api judges a
// record, the profile limit, deleted stays deleted, tombstones cleared of
// their data, no hard deletes, and passwords a write leaves out kept.
//
// They hold for superusers too: the dashboard is a client of the same API.
package hooks

import (
	"encoding/json"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/pocketbase/dbx"
	validation "github.com/pocketbase/ozzo-validation/v4"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"
	"github.com/pocketbase/pocketbase/tools/types"

	"streaming-center-sync/internal/config"
	"streaming-center-sync/internal/records"
)

// The reasons a device acts on, as a field error's code.
const (
	CodeLimit   = "sc_limit"
	CodeDeleted = "sc_deleted"
)

// Fields a tombstone keeps: what identifies it, and its parents.
var identity = []string{"id", "user", "key", "deleted", "profile", "connection", "created", "updated"}

func Register(app core.App, cfg config.Config) {
	data := records.Collections()
	profiles, _ := records.Collection(records.KindProfile)
	connections, _ := records.Collection(records.KindConnection)

	// PocketBase takes a missing, expired or invalid token for a guest, and a
	// guest's list comes back empty — which a device would take for a server
	// that lost everything, and upload its own copy over newer edits.
	app.OnRecordsListRequest(data...).BindFunc(func(e *core.RecordsListRequestEvent) error {
		if e.Auth == nil {
			return guest(e.RequestEvent)
		}
		return e.Next()
	})
	app.OnRecordViewRequest(data...).BindFunc(func(e *core.RecordRequestEvent) error {
		if e.Auth == nil {
			return guest(e.RequestEvent)
		}
		return e.Next()
	})
	app.OnBatchRequest().BindFunc(func(e *core.BatchRequestEvent) error {
		if e.Auth == nil {
			return guest(e.RequestEvent)
		}
		for index, request := range e.Batch {
			if err := asSent(e, request); err != nil {
				return refused(e.RequestEvent, index, err)
			}
		}
		return e.Next()
	})

	signedIn := func(e *core.RecordRequestEvent) error {
		if e.Auth == nil {
			return guest(e.RequestEvent)
		}
		return e.Next()
	}
	app.OnRecordCreateRequest(data...).BindFunc(signedIn)
	app.OnRecordUpdateRequest(data...).BindFunc(signedIn)

	// A record removed by hand would read as lost, and come back from the
	// devices. Deleting the account still takes all of it: a cascade is no
	// request.
	app.OnRecordDeleteRequest(data...).BindFunc(func(e *core.RecordRequestEvent) error {
		return e.ForbiddenError("Account data is never deleted: a record is deleted by writing its tombstone.", nil)
	})

	// Every write, whoever makes it — a device, the dashboard, the sign-up
	// route — before PocketBase validates and stores it.
	app.OnRecordCreate(data...).BindFunc(func(e *core.RecordEvent) error {
		clearTombstone(e.Record)
		if err := judge(e.Record, e.Record.GetString("user")); err != nil {
			return err
		}
		if e.Record.Collection().Name == profiles && !e.Record.GetBool("deleted") {
			live, err := e.App.CountRecords(profiles, dbx.HashExp{"user": e.Record.GetString("user"), "deleted": false})
			if err != nil {
				return err
			}
			if live >= int64(cfg.MaxProfiles) {
				return validation.Errors{"user": validation.NewError(CodeLimit, "The account holds as many profiles as this server allows.")}
			}
		}
		return e.Next()
	})
	app.OnRecordUpdate(data...).BindFunc(func(e *core.RecordEvent) error {
		name := e.Record.Collection().Name
		original := e.Record.Original()
		// Their ids are random and never come back; a PIN or a preference has a
		// natural key, and can be set again.
		if (name == profiles || name == connections) && original.GetBool("deleted") && !e.Record.GetBool("deleted") {
			return validation.Errors{"deleted": validation.NewError(CodeDeleted, "A deleted profile or connection stays deleted.")}
		}
		if err := keepSecrets(original, e.Record); err != nil {
			return err
		}
		clearTombstone(e.Record)
		if err := judge(e.Record, original.GetString("user")); err != nil {
			return err
		}
		return e.Next()
	})
}

// judge holds a record, as it is about to be stored, to what the api allows.
// Every write passes here, however it came; what PocketBase cast on the way —
// a "no" read as false — only the batch's own check still sees.
func judge(record *core.Record, owner string) error {
	kind, _ := records.KindOf(record.Collection().Name)
	body, err := bodyOf(record)
	if err != nil {
		return err
	}
	return records.Validate(owner, kind, record.Id, body)
}

// bodyOf is a record's stored values as the JSON a device would send for it.
func bodyOf(record *core.Record) (map[string]any, error) {
	body := map[string]any{}
	for _, field := range record.Collection().Fields {
		name := field.GetName()
		if name == "id" || name == "created" || name == "updated" {
			continue
		}
		value := record.Get(name)
		if raw, ok := value.(types.JSONRaw); ok {
			// Never written — a tombstone's — is absent, as in a device's write.
			if len(raw) == 0 {
				continue
			}
			var decoded any
			if err := json.Unmarshal(raw, &decoded); err != nil {
				return nil, err
			}
			value = decoded
		}
		body[name] = value
	}
	return body, nil
}

var recordPath = regexp.MustCompile(`^/api/collections/([^/?]+)/records(?:/([^/?]+))?(?:\?.*)?$`)

// asSent judges a batch's write as the device sent it, before PocketBase casts
// anything — the one place where a "no" sent for a boolean is still a "no".
func asSent(e *core.BatchRequestEvent, request *core.InternalRequest) error {
	match := recordPath.FindStringSubmatch(request.URL)
	if match == nil {
		return nil
	}
	kind, ok := records.KindOf(match[1])
	method := strings.ToUpper(request.Method)
	if !ok || (method != http.MethodPut && method != http.MethodPost && method != http.MethodPatch) {
		return nil
	}
	id := match[2]
	if id == "" {
		id, _ = request.Body["id"].(string)
	}
	owner := e.Auth.Id
	if e.Auth.IsSuperuser() {
		owner, _ = request.Body["user"].(string)
	}
	return records.Validate(owner, kind, id, request.Body)
}

// refused answers as PocketBase answers a batch that stopped at a write, so a
// device reads one shape whichever check refused it.
func refused(e *core.RequestEvent, index int, err error) error {
	return e.BadRequestError("Batch transaction failed.", validation.Errors{
		"requests": validation.Errors{
			strconv.Itoa(index): &refusedWrite{router.NewBadRequestError("The record is not one an account holds.", err)},
		},
	})
}

type refusedWrite struct{ response *router.ApiError }

func (w *refusedWrite) Error() string { return "Batch request failed." }
func (w *refusedWrite) Code() string  { return "batch_request_failed" }
func (w *refusedWrite) Resolve(data map[string]any) any {
	data["response"] = w.response
	return data
}

func guest(e *core.RequestEvent) error {
	return e.UnauthorizedError("Sign in: account data is for its account alone.", nil)
}

// clearTombstone empties a deleted record of its data, secrets included,
// whatever the write said: an upsert updates only the fields it carries, and a
// password left behind would sit in a record nobody reads.
func clearTombstone(record *core.Record) {
	if !record.GetBool("deleted") {
		return
	}
	for _, field := range record.Collection().Fields {
		if !slices.Contains(identity, field.GetName()) {
			record.Set(field.GetName(), nil)
		}
	}
}

// keepSecrets fills in a password the write lists without its value: a device
// that lacks one — a phone restored without its keychain — still writes the
// rest, and the password other devices saved survives. A name the write no
// longer lists drops its value.
func keepSecrets(original *core.Record, record *core.Record) error {
	if record.Collection().Fields.GetByName("secrets") == nil {
		return nil
	}
	var keys []string
	var sent, stored map[string]string
	for _, read := range []struct {
		from *core.Record
		name string
		into any
	}{{record, "secret_keys", &keys}, {record, "secrets", &sent}, {original, "secrets", &stored}} {
		if err := jsonField(read.from, read.name, read.into); err != nil {
			return err
		}
	}
	kept := make(map[string]string, len(keys))
	for _, key := range keys {
		if value, ok := sent[key]; ok {
			kept[key] = value
		} else if value, ok := stored[key]; ok {
			kept[key] = value
		}
	}
	record.Set("secrets", kept)
	return nil
}

// jsonField reads a JSON field, taking one never written — a tombstone's — for
// nothing.
func jsonField(record *core.Record, name string, into any) error {
	raw, ok := record.GetRaw(name).(types.JSONRaw)
	if !ok || len(raw) == 0 {
		return nil
	}
	return json.Unmarshal(raw, into)
}
