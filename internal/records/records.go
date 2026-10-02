// Package records is the account's record contract on the server's side:
// the collection each kind lives in, a record's derived id, and the checks
// that judge a write the way isAccountRecord in the api judges the record it
// came from. api/fixtures/account-records.json holds both sides to it.
package records

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"strings"

	validation "github.com/pocketbase/ozzo-validation/v4"
)

const (
	KindProfile         = "profile"
	KindPin             = "pin"
	KindPreference      = "preference"
	KindConnection      = "connection"
	KindProfileValues   = "profileValues"
	KindSubscription    = "subscription"
	KindPlaylist        = "playlist"
	KindFavoriteChannel = "favoriteChannel"
	KindWatchProgress   = "watchProgress"
	KindSetting         = "setting"
)

// Kinds, parents first: the order a device writes them in, so a child never
// arrives before the record it points at.
var Kinds = []string{
	KindProfile, KindPin, KindPreference, KindConnection, KindProfileValues,
	KindSubscription, KindFavoriteChannel, KindPlaylist, KindWatchProgress, KindSetting,
}

var collections = map[string]string{
	KindProfile:         "profiles",
	KindPin:             "profile_pins",
	KindPreference:      "preferences",
	KindConnection:      "connections",
	KindProfileValues:   "connection_profile_values",
	KindSubscription:    "subscriptions",
	KindPlaylist:        "playlists",
	KindFavoriteChannel: "favorite_channels",
	KindWatchProgress:   "watch_progress",
	KindSetting:         "account_settings",
}

// Collection is where a kind of record lives.
func Collection(kind string) (string, bool) {
	name, ok := collections[kind]
	return name, ok
}

// KindOf is the kind of record a collection holds.
func KindOf(collection string) (string, bool) {
	for kind, name := range collections {
		if name == collection {
			return kind, true
		}
	}
	return "", false
}

// Collections are the ones that hold account data, parents first.
func Collections() []string {
	names := make([]string, 0, len(Kinds))
	for _, kind := range Kinds {
		names = append(names, collections[kind])
	}
	return names
}

// ID is a record's id: the first 15 hex digits of SHA-256 over the account's
// id, the kind and the key, a line apart — recordId() in the api. Derived,
// never chosen, so a resent write lands on the same record and two accounts
// never collide. PocketBase's ids are 15 characters of [a-z0-9].
func ID(accountID, kind, key string) string {
	sum := sha256.Sum256([]byte(accountID + "\n" + kind + "\n" + key))
	return hex.EncodeToString(sum[:])[:15]
}

// The api's limits, measured as it measures them: in UTF-16 code units.
const (
	MaxRecordLength = 256 * 1024
	maxSecret       = 4 * 1024
	maxID           = 128
	maxText         = 200
	maxDepth        = 32
	// An image reference is an address more often than not, and some run long.
	maxLogo = 2048
	// An identity is a catalogue id, or a title and a year: never long.
	maxIdentity = 300
)

var (
	keyPattern    = regexp.MustCompile(`^[a-z][A-Za-z0-9]*$`)
	hashPattern   = regexp.MustCompile(`^[0-9a-f]{16}$`)
	pinPattern    = regexp.MustCompile(`^[0-9]{4}$`)
	pluginPattern = regexp.MustCompile(`^(sources|iptv|metadata)/[a-z][a-z0-9-]*$`)
	perProfile    = []string{"none", "credentials", "all"}
)

// Validate judges a write as the api judges the record it came from. `body` is
// the JSON a device sent, before PocketBase casts anything: a "no" where a
// boolean belongs is refused here, where PocketBase would quietly read false.
// `id` is the id the record is stored under, and `owner` the account it
// belongs to.
func Validate(owner, kind, id string, body map[string]any) error {
	errs := validation.Errors{}
	key, ok := body["key"].(string)
	if !ok {
		return validation.Errors{"key": invalid("the record's key is missing")}
	}
	parts, ok := keyParts(kind, key)
	if !ok {
		return validation.Errors{"key": invalid("the key does not have its kind's shape")}
	}
	deleted, ok := body["deleted"].(bool)
	if !ok {
		return validation.Errors{"deleted": invalid("deleted is not a boolean")}
	}
	if id != ID(owner, kind, key) {
		errs["id"] = invalid("the id is not the one derived from the account and the key")
	}
	if user, sent := body["user"]; sent && user != owner {
		errs["user"] = invalid("a record belongs to its own account")
	}

	// A child points at its parents by their derived ids, from its own key: it
	// cannot name another account's record, or a parent its key does not.
	switch kind {
	case KindPin, KindPreference, KindWatchProgress:
		expect(errs, body, "profile", ID(owner, KindProfile, parts[0]))
	case KindProfileValues:
		expect(errs, body, "connection", ID(owner, KindConnection, parts[0]))
		expect(errs, body, "profile", ID(owner, KindProfile, parts[1]))
	case KindSubscription, KindFavoriteChannel, KindPlaylist:
		// Their key is a generated id and names no parent, so the parents come
		// from the body — and the relation must agree with the key beside it,
		// or a device could point one account's record at another's profile.
		if !deleted {
			expectDerived(errs, body, "profile", "profile_key", owner, KindProfile)
			if kind != KindPlaylist {
				expectDerived(errs, body, "connection", "connection_key", owner, KindConnection)
			}
		}
	}

	if !deleted {
		liveData(errs, kind, parts, body)
	}

	if len(errs) == 0 {
		if encoded, err := json.Marshal(body); err != nil || len(encoded) > MaxRecordLength {
			errs["key"] = invalid("the record is heavier than the limit")
		}
	}
	if len(errs) > 0 {
		return errs
	}
	return nil
}

func liveData(errs validation.Errors, kind string, parts []string, body map[string]any) {
	switch kind {
	case KindProfile:
		if name, ok := body["name"].(string); !ok || !isText(name) || strings.TrimSpace(name) == "" {
			errs["name"] = invalid("a profile's name is text, and not blank")
		}
	case KindPin:
		// The api's null is an empty string here.
		if pin, ok := body["pin"].(string); !ok || (pin != "" && !pinPattern.MatchString(pin)) {
			errs["pin"] = invalid("a PIN is four digits, or none")
		}
	case KindPreference:
		if name, ok := body["name"].(string); !ok || name != parts[1] {
			errs["name"] = invalid("a preference's name is the one its key names")
		}
		if value, ok := body["value"]; !ok || !isJSON(value, 0) {
			errs["value"] = invalid("a preference's value is JSON")
		}
	case KindConnection:
		if plugin, ok := body["plugin_id"].(string); !ok || !pluginPattern.MatchString(plugin) {
			errs["plugin_id"] = invalid("only sources, IPTV and metadata travel with the account")
		}
		if label, ok := body["label"].(string); !ok || !isText(label) {
			errs["label"] = invalid("a label is text")
		}
		if _, ok := body["enabled"].(bool); !ok {
			errs["enabled"] = invalid("enabled is a boolean")
		}
		if mode, ok := body["per_profile"].(string); !ok || !contains(perProfile, mode) {
			errs["per_profile"] = invalid("per_profile is none, credentials or all")
		}
		values(errs, body)
	case KindProfileValues:
		if _, ok := body["off"].(bool); !ok {
			errs["off"] = invalid("off is a boolean")
		}
		values(errs, body)
	case KindSubscription:
		if external, ok := body["external_id"].(string); !ok || !isID(external) {
			errs["external_id"] = invalid("a subscription names a channel on its source")
		}
		if title, ok := body["title"].(string); !ok || !isText(title) {
			errs["title"] = invalid("a title is text")
		}
		if added, ok := body["added_at"].(string); !ok || !isText(added) {
			errs["added_at"] = invalid("added_at is a date, as text")
		}
	case KindFavoriteChannel:
		if external, ok := body["external_id"].(string); !ok || !isID(external) {
			errs["external_id"] = invalid("a favourite names a channel on its source")
		}
		if name, ok := body["name"].(string); !ok || !isText(name) || strings.TrimSpace(name) == "" {
			errs["name"] = invalid("a channel's name is text, and not blank")
		}
		// The api's missing number is 0 here, and its missing logo empty:
		// PocketBase has no null for either.
		if number, ok := wholeNumber(body["number"]); !ok || number < 0 {
			errs["number"] = invalid("a channel's number is a whole number, 0 for none")
		}
		if logo, ok := body["logo"].(string); !ok || utf16Len(logo) > maxLogo {
			errs["logo"] = invalid("a logo is a reference no longer than an address")
		}
		if added, ok := body["added_at"].(string); !ok || !isText(added) {
			errs["added_at"] = invalid("added_at is a date, as text")
		}
	case KindWatchProgress:
		if identity, ok := body["identity"].(string); !ok || identity == "" || utf16Len(identity) > maxIdentity {
			errs["identity"] = invalid("an identity names what was watched, briefly")
		}
		// `{}` is how no catalogue ids, and no snapshot, are stored: PocketBase has no null.
		if ids, ok := body["external_ids"].(map[string]any); !ok || !isIDMap(ids) {
			errs["external_ids"] = invalid("catalogue ids are short texts under camelCase names")
		}
		if round, ok := wholeNumber(body["round"]); !ok || round < 0 {
			errs["round"] = invalid("a round is a whole number from nought")
		}
		if _, ok := body["watched"].(bool); !ok {
			errs["watched"] = invalid("watched is a boolean")
		}
		for _, name := range []string{"position_ms", "duration_ms"} {
			if at, ok := wholeNumber(body[name]); !ok || at < 0 {
				errs[name] = invalid(name + " is a whole number from nought, 0 for none")
			}
		}
		if item, ok := body["item"].(map[string]any); !ok || !isJSON(item, 0) {
			errs["item"] = invalid("a snapshot is an object, or empty")
		}
		for _, name := range []string{"created_at", "updated_at"} {
			if at, ok := body[name].(string); !ok || !isText(at) {
				errs[name] = invalid(name + " is a date, as text")
			}
		}
	case KindSetting:
		if value, ok := body["value"]; !ok || !isJSON(value, 0) {
			errs["value"] = invalid("a setting's value is JSON")
		}
	case KindPlaylist:
		if title, ok := body["title"].(string); !ok || !isText(title) || strings.TrimSpace(title) == "" {
			errs["title"] = invalid("a playlist's title is text, and not blank")
		}
		if description, ok := body["description"].(string); !ok || !isText(description) {
			errs["description"] = invalid("a description is text")
		}
		if !isMediaKeyList(body["items"]) {
			errs["items"] = invalid("a playlist's items each name a connection and an id on it")
		}
		// `{}` is how "not a mirror of anything" is stored: PocketBase's JSON
		// field has no null, and an absent source is the common case.
		if source, ok := body["source"].(map[string]any); !ok || (len(source) > 0 && !isMediaKey(source)) {
			errs["source"] = invalid("a source names a connection and an id on it, or is empty")
		}
		for _, name := range []string{"created_at", "updated_at"} {
			if at, ok := body[name].(string); !ok || !isText(at) {
				errs[name] = invalid(name + " is a date, as text")
			}
		}
	}
}

// maxList is the api's MAX_LIST: long enough for anyone, short enough that the
// whole account still reads in one go.
const maxList = 2000

func isMediaKey(value any) bool {
	entry, ok := value.(map[string]any)
	if !ok {
		return false
	}
	connection, hasConnection := entry["connectionId"].(string)
	external, hasExternal := entry["externalId"].(string)
	return hasConnection && hasExternal && isID(connection) && isID(external)
}

func isMediaKeyList(value any) bool {
	entries, ok := value.([]any)
	if !ok || len(entries) > maxList {
		return false
	}
	for _, entry := range entries {
		if !isMediaKey(entry) {
			return false
		}
	}
	return true
}

// values checks what a connection and a profile's values share: their fields,
// settings and passwords.
func values(errs validation.Errors, body map[string]any) {
	for _, name := range []string{"fields", "settings"} {
		if !isFieldValues(body[name]) {
			errs[name] = invalid(name + " are text, switches and library choices, under camelCase keys")
		}
	}
	keys, ok := keyList(body["secret_keys"])
	if !ok {
		errs["secret_keys"] = invalid("secret_keys lists camelCase names")
		return
	}
	if !isSecrets(body["secrets"], keys) {
		errs["secrets"] = invalid("secrets are text, only for the names secret_keys lists")
	}
}

// expectDerived checks that a relation is the derived id of the key beside it:
// the key says which profile, and the relation must be that profile's id.
func expectDerived(errs validation.Errors, body map[string]any, field, keyField, owner, parentKind string) {
	parentKey, ok := body[keyField].(string)
	if !ok || !isID(parentKey) {
		errs[keyField] = invalid("the parent's key is missing")
		return
	}
	expect(errs, body, field, ID(owner, parentKind, parentKey))
}

func expect(errs validation.Errors, body map[string]any, field, want string) {
	if got, ok := body[field].(string); !ok || got != want {
		errs[field] = invalid("the parent is not the one the key names")
	}
}

// keyParts splits a key into the ids it joins, when it has its kind's shape.
func keyParts(kind string, key string) ([]string, bool) {
	parts := strings.Split(key, "/")
	switch kind {
	case KindPreference:
		return parts, len(parts) == 2 && isID(parts[0]) && isKey(parts[1])
	case KindProfileValues:
		return parts, len(parts) == 2 && isID(parts[0]) && isID(parts[1])
	case KindProfile, KindPin, KindConnection, KindSubscription, KindFavoriteChannel, KindPlaylist:
		return parts, len(parts) == 1 && isID(parts[0])
	case KindWatchProgress:
		// Its profile, and the hash of what was watched: the same from every device.
		return parts, len(parts) == 2 && isID(parts[0]) && hashPattern.MatchString(parts[1])
	case KindSetting:
		return parts, len(parts) == 1 && isKey(parts[0])
	}
	return nil, false
}

// IdentityHash is identityHash() in the api: sixteen hex digits standing for
// an identity in a watch record's key — FNV-1a over its UTF-8, twice with
// different offsets. Never a secret, only a name.
func IdentityHash(identity string) string {
	pass := func(offset uint32) uint32 {
		hash := offset
		for _, b := range []byte(identity) {
			hash ^= uint32(b)
			hash *= 0x01000193
		}
		return hash
	}
	return fmt.Sprintf("%08x%08x", pass(0x811c9dc5), pass(0x050c5d1f))
}

func isIDMap(ids map[string]any) bool {
	for key, value := range ids {
		id, ok := value.(string)
		if !ok || !isKey(key) || !isID(id) {
			return false
		}
	}
	return true
}

func invalid(message string) validation.Error {
	return validation.NewError("sc_invalid", message)
}

// utf16Len measures as JavaScript's `length` does.
func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return n
}

// wholeNumber reads a number as a device's JSON brings it — a float64 — or as
// a test writes one, and says whether it is whole.
func wholeNumber(value any) (float64, bool) {
	var number float64
	switch typed := value.(type) {
	case float64:
		number = typed
	case int:
		number = float64(typed)
	case int64:
		number = float64(typed)
	default:
		return 0, false
	}
	return number, !math.IsInf(number, 0) && number == math.Trunc(number)
}

// isID refuses a slash: ids join into keys with one, so an id holding it could
// pass for another.
func isID(s string) bool {
	return s != "" && utf16Len(s) <= maxID && !strings.Contains(s, "/")
}

func isKey(s string) bool {
	return len(s) <= maxID && keyPattern.MatchString(s)
}

func isText(s string) bool {
	return utf16Len(s) <= maxText
}

func keyList(value any) ([]string, bool) {
	list, ok := value.([]any)
	if !ok || len(list) > maxID {
		return nil, false
	}
	keys := make([]string, 0, len(list))
	for _, entry := range list {
		key, ok := entry.(string)
		if !ok || !isKey(key) {
			return nil, false
		}
		keys = append(keys, key)
	}
	return keys, true
}

func isFieldValues(value any) bool {
	fields, ok := value.(map[string]any)
	if !ok {
		return false
	}
	for key, entry := range fields {
		if !isKey(key) {
			return false
		}
		switch entry.(type) {
		case string, bool:
			continue
		}
		if !isLibrarySelection(entry) {
			return false
		}
	}
	return true
}

func isLibrarySelection(value any) bool {
	selection, ok := value.(map[string]any)
	if !ok {
		return false
	}
	switch selection["mode"] {
	case "all":
		return true
	case "only", "except":
		ids, ok := selection["ids"].([]any)
		if !ok {
			return false
		}
		for _, id := range ids {
			if _, ok := id.(string); !ok {
				return false
			}
		}
		return true
	}
	return false
}

func isSecrets(value any, keys []string) bool {
	secrets, ok := value.(map[string]any)
	if !ok {
		return false
	}
	for key, secret := range secrets {
		text, ok := secret.(string)
		if !ok || !contains(keys, key) || utf16Len(text) > maxSecret {
			return false
		}
	}
	return true
}

func isJSON(value any, depth int) bool {
	if depth > maxDepth {
		return false
	}
	switch v := value.(type) {
	case nil, string, bool:
		return true
	case float64:
		return !math.IsInf(v, 0) && !math.IsNaN(v)
	case json.Number:
		_, err := v.Float64()
		return err == nil
	case []any:
		for _, entry := range v {
			if !isJSON(entry, depth+1) {
				return false
			}
		}
		return true
	case map[string]any:
		for _, entry := range v {
			if !isJSON(entry, depth+1) {
				return false
			}
		}
		return true
	}
	return false
}

func contains(list []string, value string) bool {
	for _, entry := range list {
		if entry == value {
			return true
		}
	}
	return false
}
