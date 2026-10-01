// Package fixtures reads the records the api's tests read too, and writes each
// one as the sync/custom-server plugin sends it. Only tests import it: the
// server never sees an api record, only the bodies the plugin makes of them.
package fixtures

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"

	"streaming-center-sync/internal/records"
)

type Invalid struct {
	Why    string         `json:"why"`
	Record map[string]any `json:"record"`
}

type RecordID struct {
	AccountID string `json:"accountId"`
	Kind      string `json:"kind"`
	Key       string `json:"key"`
	ID        string `json:"id"`
}

type Fixtures struct {
	Valid     []map[string]any `json:"valid"`
	Invalid   []Invalid        `json:"invalid"`
	RecordIDs []RecordID       `json:"recordIds"`
}

// Load reads adapters/api/fixtures/account-records.json from the app, which
// sits beside this one: the adapters moved in with Phase 9.
func Load() (Fixtures, error) {
	_, here, _, _ := runtime.Caller(0)
	path := filepath.Join(filepath.Dir(here), "..", "..", "..", "streaming_center_app", "adapters", "api", "fixtures", "account-records.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		return Fixtures{}, err
	}
	var f Fixtures
	err = json.Unmarshal(raw, &f)
	return f, err
}

// ToBody writes a record as the plugin sends it: its kind's collection, the
// derived id, the account, the key, parents by their derived ids, and the data
// in snake_case. What the plugin refuses to send — an unknown kind, a key that
// is not its data's — is refused here, before the server sees it; everything
// else goes out as it is, for the server to judge.
func ToBody(owner string, record map[string]any) (kind string, id string, body map[string]any, ok bool) {
	kind, _ = record["kind"].(string)
	if _, known := records.Collection(kind); !known {
		return "", "", nil, false
	}
	key, _ := record["key"].(string)
	body = map[string]any{"user": owner, "key": record["key"], "deleted": record["deleted"]}
	parents(owner, kind, key, body)
	if data, isMap := record["data"].(map[string]any); isMap {
		listParents(owner, kind, data, body)
	}

	if record["deleted"] != true {
		if data, isMap := record["data"].(map[string]any); isMap {
			if keyOf(kind, data) != key {
				return "", "", nil, false
			}
			for from, to := range fieldsOf[kind] {
				if value, present := data[from]; present {
					body[to] = value
				}
			}
			// The api's missing PIN is an empty one on the server.
			if kind == records.KindPin && data["pin"] == nil {
				body["pin"] = ""
			}
			// The api leaves these out; PocketBase has no null for them.
			if kind == records.KindPlaylist {
				if _, present := body["description"]; !present {
					body["description"] = ""
				}
				if _, present := body["source"]; !present {
					body["source"] = map[string]any{}
				}
			}
		}
	}
	id = records.ID(owner, kind, key)
	body["id"] = id
	return kind, id, body, true
}

var fieldsOf = map[string]map[string]string{
	records.KindProfile:    {"name": "name"},
	records.KindPin:        {"pin": "pin"},
	records.KindPreference: {"name": "name", "value": "value"},
	records.KindConnection: {
		"pluginId": "plugin_id", "label": "label", "enabled": "enabled", "perProfile": "per_profile",
		"fields": "fields", "settings": "settings", "secretKeys": "secret_keys", "secrets": "secrets",
	},
	records.KindProfileValues: {
		"off": "off", "fields": "fields", "settings": "settings", "secretKeys": "secret_keys", "secrets": "secrets",
	},
	records.KindSubscription: {
		"userId": "profile_key", "connectionId": "connection_key",
		"externalId": "external_id", "title": "title", "addedAt": "added_at",
	},
	records.KindPlaylist: {
		"userId": "profile_key", "title": "title", "description": "description",
		"items": "items", "source": "source", "createdAt": "created_at", "updatedAt": "updated_at",
	},
}

// keyOf is recordKey() in the api.
func keyOf(kind string, data map[string]any) string {
	text := func(name string) string {
		value, _ := data[name].(string)
		return value
	}
	switch kind {
	case records.KindProfile, records.KindPin:
		return text("userId")
	case records.KindPreference:
		return text("userId") + "/" + text("name")
	case records.KindConnection:
		return text("connectionId")
	case records.KindSubscription:
		return text("subscriptionId")
	case records.KindPlaylist:
		return text("playlistId")
	default:
		return text("connectionId") + "/" + text("userId")
	}
}

// listParents: a subscription's and a playlist's key is a generated id and
// names no parent, so the parents come from the data. A tombstone has none,
// and the server keeps the relations it already stored.
func listParents(owner, kind string, data map[string]any, body map[string]any) {
	text := func(name string) string {
		value, _ := data[name].(string)
		return value
	}
	switch kind {
	case records.KindSubscription:
		body["profile"] = records.ID(owner, records.KindProfile, text("userId"))
		body["connection"] = records.ID(owner, records.KindConnection, text("connectionId"))
	case records.KindPlaylist:
		body["profile"] = records.ID(owner, records.KindProfile, text("userId"))
	}
}

func parents(owner, kind, key string, body map[string]any) {
	parts := splitTwo(key)
	switch kind {
	case records.KindPin, records.KindPreference:
		body["profile"] = records.ID(owner, records.KindProfile, parts[0])
	case records.KindProfileValues:
		body["connection"] = records.ID(owner, records.KindConnection, parts[0])
		body["profile"] = records.ID(owner, records.KindProfile, parts[1])
	}
}

func splitTwo(key string) [2]string {
	for i := 0; i < len(key); i++ {
		if key[i] == '/' {
			return [2]string{key[:i], key[i+1:]}
		}
	}
	return [2]string{key, ""}
}
