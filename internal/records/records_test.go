package records_test

import (
	"strings"
	"testing"

	"foyer/internal/fixtures"
	"foyer/internal/records"
)

func load(t *testing.T) fixtures.Fixtures {
	t.Helper()
	f, err := fixtures.Load()
	if err != nil {
		t.Fatalf("the shared fixtures sit in the app's repository beside this one: %v", err)
	}
	return f
}

const owner = "k4r9x2m1q8w3e5t"

func TestDerivesTheIdsTheApiDerives(t *testing.T) {
	for _, vector := range load(t).RecordIDs {
		if got := records.ID(vector.AccountID, vector.Kind, vector.Key); got != vector.ID {
			t.Errorf("%s %s: derived %s, the api derives %s", vector.Kind, vector.Key, got, vector.ID)
		}
	}
}

func TestAcceptsEveryValidRecord(t *testing.T) {
	for _, record := range load(t).Valid {
		kind, id, body, ok := fixtures.ToBody(owner, record)
		if !ok {
			t.Errorf("%v: refused before it was sent", record)
			continue
		}
		if err := records.Validate(owner, kind, id, body); err != nil {
			t.Errorf("%v: refused: %v", record, err)
		}
	}
}

func TestRefusesEveryInvalidRecord(t *testing.T) {
	for _, fixture := range load(t).Invalid {
		kind, id, body, ok := fixtures.ToBody(owner, fixture.Record)
		if ok && records.Validate(owner, kind, id, body) == nil {
			t.Errorf("accepted %s", fixture.Why)
		}
	}
}

func TestRefusesWhatTheSharedShapeCannotSay(t *testing.T) {
	profile := func(change func(map[string]any)) map[string]any {
		body := map[string]any{"user": owner, "key": "u1", "deleted": false, "name": "Alex"}
		change(body)
		return body
	}
	profileID := records.ID(owner, records.KindProfile, "u1")
	pinID := records.ID(owner, records.KindPin, "u1")
	preferenceID := records.ID(owner, records.KindPreference, "u1/homeLayout")
	cases := []struct {
		why, kind, id string
		body          map[string]any
	}{
		{"an id the device chose", records.KindProfile, "abcdefghijklmno", profile(func(map[string]any) {})},
		{"another account's record", records.KindProfile, profileID, profile(func(b map[string]any) { b["user"] = "someoneelse0000" })},
		{"a boolean written as text", records.KindProfile, profileID, profile(func(b map[string]any) { b["deleted"] = "false" })},
		{"a name over the limit", records.KindProfile, profileID, profile(func(b map[string]any) { b["name"] = strings.Repeat("a", 201) })},
		{"a PIN whose parent is not its key's", records.KindPin, pinID, map[string]any{
			"user": owner, "key": "u1", "deleted": false, "pin": "1234", "profile": records.ID(owner, records.KindProfile, "u2"),
		}},
		{"a tombstone without its parent", records.KindPin, pinID, map[string]any{"user": owner, "key": "u1", "deleted": true}},
		{"a preference named apart from its key", records.KindPreference, preferenceID, map[string]any{
			"user": owner, "key": "u1/homeLayout", "deleted": false, "name": "other", "value": 1, "profile": profileID,
		}},
	}
	for _, c := range cases {
		if records.Validate(owner, c.kind, c.id, c.body) == nil {
			t.Errorf("accepted %s", c.why)
		}
	}
}

func TestRefusesARecordHeavierThanTheLimit(t *testing.T) {
	key := "u1/homeLayout"
	body := map[string]any{
		"user": owner, "key": key, "deleted": false, "name": "homeLayout",
		"value": strings.Repeat("x", records.MaxRecordLength), "profile": records.ID(owner, records.KindProfile, "u1"),
	}
	if records.Validate(owner, records.KindPreference, records.ID(owner, records.KindPreference, key), body) == nil {
		t.Fatal("accepted a record over the limit")
	}
}

func TestCollectionsAndKindsGoBothWays(t *testing.T) {
	for _, kind := range records.Kinds {
		collection, ok := records.Collection(kind)
		if !ok {
			t.Fatalf("%s has no collection", kind)
		}
		if back, _ := records.KindOf(collection); back != kind {
			t.Errorf("%s → %s → %s", kind, collection, back)
		}
	}
	if _, ok := records.Collection("comment"); ok {
		t.Error("an unknown kind has a collection")
	}
}
