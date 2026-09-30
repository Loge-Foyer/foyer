// Package records is the account's record contract on the server's side:
// the collection each kind lives in, a record's derived id, and the checks
// that judge a write the way isAccountRecord in the api judges the record it
// came from. api/fixtures/account-records.json holds both sides to it.
package records

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"math"
	"regexp"
	"strings"

	validation "github.com/pocketbase/ozzo-validation/v4"
)

const (
	KindProfile       = "profile"
	KindPin           = "pin"
	KindPreference    = "preference"
	KindConnection    = "connection"
	KindProfileValues = "profileValues"
)

// Kinds, parents first: the order a device writes them in, so a child never
// arrives before the record it points at.
var Kinds = []string{KindProfile, KindPin, KindPreference, KindConnection, KindProfileValues}

var collections = map[string]string{
	KindProfile:       "profiles",
	KindPin:           "profile_pins",
	KindPreference:    "preferences",
	KindConnection:    "connections",
	KindProfileValues: "connection_profile_values",
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

// Collections are the five that hold account data, parents first.
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
)

var (
	keyPattern    = regexp.MustCompile(`^[a-z][A-Za-z0-9]*$`)
	pinPattern    = regexp.MustCompile(`^[0-9]{4}$`)
	pluginPattern = regexp.MustCompile(`^(sources|iptv)/[a-z][a-z0-9-]*$`)
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
	case KindPin, KindPreference:
		expect(errs, body, "profile", ID(owner, KindProfile, parts[0]))
	case KindProfileValues:
		expect(errs, body, "connection", ID(owner, KindConnection, parts[0]))
		expect(errs, body, "profile", ID(owner, KindProfile, parts[1]))
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
			errs["plugin_id"] = invalid("only sources and IPTV travel with the account")
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
	}
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
	case KindProfile, KindPin, KindConnection:
		return parts, len(parts) == 1 && isID(parts[0])
	}
	return nil, false
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
