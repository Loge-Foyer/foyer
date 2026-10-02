package server_test

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"

	"foyer/internal/config"
	"foyer/internal/fixtures"
	"foyer/internal/invites"
	"foyer/internal/records"
	"foyer/internal/server"
	"foyer/internal/version"
)

func TestNeverOpensTheInstaller(t *testing.T) {
	app, err := tests.NewTestAppWithConfig(core.BaseAppConfig{DataDir: t.TempDir(), EncryptionEnv: "pb_test_env"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Cleanup)
	// A test app skips PocketBase's installer by itself, first of all. Arm it
	// again, as `serve` does, so that only Bind can skip it.
	app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		e.InstallerFunc = apis.DefaultInstallerFunc
		return e.Next()
	})
	server.Bind(app, config.Config{MaxProfiles: config.DefaultMaxProfiles, SignUp: config.SignUpInvite})
	router, err := apis.NewRouter(app)
	if err != nil {
		t.Fatal(err)
	}
	serve := &core.ServeEvent{App: app, Router: router}
	if err := app.OnServe().Trigger(serve, func(e *core.ServeEvent) error {
		if e.InstallerFunc != nil {
			t.Error("the installer would open a browser tab")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestTheServerIsFoyer(t *testing.T) {
	h := start(t, options{})
	settings := h.app.Settings()
	labels := []string{}
	for _, rule := range settings.RateLimits.Rules {
		labels = append(labels, rule.Label)
	}
	if settings.Meta.AppName != "Foyer" || slices.Contains(labels, "/api/sc/sign-up") || !slices.Contains(labels, "/api/foyer/sign-up") {
		t.Fatalf("name %q, rate limit rules %v", settings.Meta.AppName, labels)
	}
}

func TestInfoNeedsNoSession(t *testing.T) {
	h := start(t, options{cfg: config.Config{MaxProfiles: 4, SignUp: config.SignUpInvite}})
	got := h.call(http.MethodGet, "/api/foyer/info", "", nil)
	if got.status != http.StatusOK || got.body["maxProfiles"] != float64(4) || got.body["signUp"] != "invite" || got.body["serverVersion"] != version.Version {
		t.Fatalf("info: %d %v", got.status, got.body)
	}
}

// --- Signing up ---------------------------------------------------------------

func TestSignUpOpenMakesAnAccountAndSignsItIn(t *testing.T) {
	h := start(t, options{})
	alex := h.signUp("Alex", map[string]any{"firstProfile": true})

	// The first profile is named after the account, under the id a device derives for its key.
	profiles := h.items(alex, records.KindProfile)
	if len(profiles) != 1 || profiles[0]["name"] != "Alex" {
		t.Fatalf("first profile: %v", profiles)
	}
	key := profiles[0]["key"].(string)
	if profiles[0]["id"] != records.ID(alex.id, records.KindProfile, key) {
		t.Fatalf("the first profile's id is not derived from its key: %v", profiles[0])
	}

	// A device uploading a local account asks for none.
	sam := h.signUp("Sam", nil)
	if got := h.items(sam, records.KindProfile); len(got) != 0 {
		t.Fatalf("an account without a first profile holds %v", got)
	}
}

func TestSignUpClosedTakesNobody(t *testing.T) {
	h := start(t, options{cfg: config.Config{SignUp: config.SignUpClosed}})
	got := h.call(http.MethodPost, "/api/foyer/sign-up", "", map[string]any{"username": "alex", "password": "a long password"})
	if got.status != http.StatusForbidden {
		t.Fatalf("closed sign-up: %d %v", got.status, got.body)
	}
}

func TestAnInviteMakesOneAccountOnly(t *testing.T) {
	h := start(t, options{cfg: config.Config{SignUp: config.SignUpInvite}})
	code, _, err := invites.Create(h.app, time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	// Refused without one, before the username is looked at: nobody learns which exist.
	if got := h.call(http.MethodPost, "/api/foyer/sign-up", "", map[string]any{"username": "alex", "password": "a long password"}); got.status != http.StatusForbidden {
		t.Fatalf("no invite: %d %v", got.status, got.body)
	}
	// Typed any way it likes.
	alex := h.signUp("alex", map[string]any{"invite": strings.ToLower(strings.ReplaceAll(code, "-", " "))})
	invite, err := h.app.FindFirstRecordByData(invites.Collection, "code_hash", invites.Hash(code))
	if err != nil || invite.GetString("used_by") != alex.id {
		t.Fatalf("the invite does not name its account: %v %v", invite, err)
	}
	if got := h.call(http.MethodPost, "/api/foyer/sign-up", "", map[string]any{"username": "sam", "password": "a long password", "invite": code}); got.status != http.StatusForbidden {
		t.Fatalf("a spent invite: %d %v", got.status, got.body)
	}
}

func TestAnInviteIsNeverSpentOnAnAccountNotMade(t *testing.T) {
	h := start(t, options{cfg: config.Config{SignUp: config.SignUpInvite}})
	code, _, err := invites.Create(h.app, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	// Too short a password: the account is refused, and the invite stays good.
	if got := h.call(http.MethodPost, "/api/foyer/sign-up", "", map[string]any{"username": "alex", "password": "short", "invite": code}); got.status != http.StatusBadRequest {
		t.Fatalf("a short password: %d %v", got.status, got.body)
	}
	h.signUp("alex", map[string]any{"invite": code})
}

func TestAnExpiredInviteWillNotDo(t *testing.T) {
	h := start(t, options{cfg: config.Config{SignUp: config.SignUpInvite}})
	code, _, err := invites.Create(h.app, -time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if got := h.call(http.MethodPost, "/api/foyer/sign-up", "", map[string]any{"username": "alex", "password": "a long password", "invite": code}); got.status != http.StatusForbidden {
		t.Fatalf("an expired invite: %d %v", got.status, got.body)
	}
}

func TestUsernamesAreOneAccountEachWhateverTheCase(t *testing.T) {
	h := start(t, options{})
	h.signUp("Alex", nil)
	got := h.call(http.MethodPost, "/api/foyer/sign-up", "", map[string]any{"username": "alex", "password": "a long password"})
	if got.status != http.StatusBadRequest {
		t.Fatalf("a taken username: %d %v", got.status, got.body)
	}
	// And signing in does not care about case either.
	if got := h.signIn("ALEX", "a long password"); got.status != http.StatusOK {
		t.Fatalf("sign-in by another case: %d %v", got.status, got.body)
	}
}

func TestPocketBasesOwnRegistrationIsClosed(t *testing.T) {
	h := start(t, options{})
	got := h.call(http.MethodPost, "/api/collections/users/records", "", map[string]any{
		"username": "mallory", "password": "a long password", "passwordConfirm": "a long password",
	})
	if got.status != http.StatusForbidden {
		t.Fatalf("public create: %d %v", got.status, got.body)
	}
}

// --- The rules ----------------------------------------------------------------

func TestAccountsNeverSeeEachOther(t *testing.T) {
	h := start(t, options{})
	alex, sam := h.signUp("alex", nil), h.signUp("sam", nil)
	if got := h.batch(alex, put(records.KindProfile, profile(alex, "u1", "Alex"))); got.status != http.StatusOK {
		t.Fatalf("alex's write: %d %v", got.status, got.body)
	}
	if got := h.items(sam, records.KindProfile); len(got) != 0 {
		t.Fatalf("sam sees %v", got)
	}
	// A write naming another account is refused: by its derived id, and by the rules.
	mine := profile(alex, "u2", "Mallory")
	mine["user"] = alex.id
	if got := h.batch(sam, put(records.KindProfile, mine)); got.status != http.StatusBadRequest {
		t.Fatalf("sam writing for alex: %d %v", got.status, got.body)
	}
	if got := h.call(http.MethodGet, "/api/collections/profiles/records/"+records.ID(alex.id, records.KindProfile, "u1"), sam.token, nil); got.status != http.StatusNotFound {
		t.Fatalf("sam viewing alex's profile: %d %v", got.status, got.body)
	}
}

func TestGuestsGetNoAccountData(t *testing.T) {
	h := start(t, options{})
	alex := h.signUp("alex", nil)
	guest := account{id: alex.id}
	for _, kind := range records.Kinds {
		if got := h.list(guest, kind); got.status != http.StatusUnauthorized {
			t.Errorf("a guest listing %s: %d — an empty list reads as a server that lost everything", kind, got.status)
		}
	}
	if got := h.batch(guest, put(records.KindProfile, profile(alex, "u1", "Alex"))); got.status != http.StatusUnauthorized {
		t.Fatalf("a guest's batch: %d %v", got.status, got.body)
	}
	// An ended session is a guest to PocketBase: the same 401.
	expired := account{id: alex.id, token: alex.token + "x"}
	if got := h.list(expired, records.KindProfile); got.status != http.StatusUnauthorized {
		t.Fatalf("a bad token listing: %d", got.status)
	}
}

// --- The batch ----------------------------------------------------------------

func TestABatchIsStoredWholeOrNotAtAll(t *testing.T) {
	h := start(t, options{})
	alex := h.signUp("alex", nil)
	bad := pin(alex, "u1", "12345")
	got := h.batch(alex,
		put(records.KindProfile, profile(alex, "u1", "Alex")),
		put(records.KindPin, pin(alex, "u1", "1234")),
		put(records.KindPin, bad),
	)
	index, codes := refusal(t, got)
	if index != "2" || !slices.Contains(codes, "foyer_invalid") {
		t.Fatalf("the refusal names %s %v", index, codes)
	}
	if stored := h.items(alex, records.KindProfile); len(stored) != 0 {
		t.Fatalf("half a batch was stored: %v", stored)
	}
}

func TestAResentBatchChangesNothing(t *testing.T) {
	h := start(t, options{})
	alex := h.signUp("alex", nil)
	writes := []map[string]any{
		put(records.KindProfile, profile(alex, "u1", "Alex")),
		put(records.KindPin, pin(alex, "u1", "1234")),
		put(records.KindConnection, connection(alex, "c1", []string{"password"}, map[string]any{"password": "correct horse"})),
	}
	for round := 0; round < 2; round++ {
		if got := h.batch(alex, writes...); got.status != http.StatusOK {
			t.Fatalf("round %d: %d %v", round, got.status, got.body)
		}
	}
	for _, kind := range []string{records.KindProfile, records.KindPin, records.KindConnection} {
		if got := h.items(alex, kind); len(got) != 1 {
			t.Fatalf("%s after a resend: %v", kind, got)
		}
	}
}

func TestABatchJudgesWhatWasSentBeforeItIsCast(t *testing.T) {
	h := start(t, options{})
	alex := h.signUp("alex", nil)
	sent := profile(alex, "u1", "Alex")
	// PocketBase would read "no" as false.
	sent["deleted"] = "no"
	index, codes := refusal(t, h.batch(alex, put(records.KindProfile, sent)))
	if index != "0" || !slices.Contains(codes, "foyer_invalid") {
		t.Fatalf("the refusal names %s %v", index, codes)
	}
}

func TestTheProfileLimitCountsLiveProfilesOnly(t *testing.T) {
	h := start(t, options{cfg: config.Config{MaxProfiles: 2}})
	alex := h.signUp("alex", nil)
	if got := h.batch(alex,
		put(records.KindProfile, profile(alex, "u1", "Alex")),
		put(records.KindProfile, profile(alex, "u2", "Sam")),
	); got.status != http.StatusOK {
		t.Fatalf("two profiles: %d %v", got.status, got.body)
	}
	index, codes := refusal(t, h.batch(alex, put(records.KindProfile, profile(alex, "u3", "Robin"))))
	if index != "0" || !slices.Contains(codes, "foyer_limit") {
		t.Fatalf("a third: %s %v", index, codes)
	}
	// Deleting one makes room.
	if got := h.batch(alex,
		put(records.KindProfile, tombstone(alex, records.KindProfile, "u2", nil)),
		put(records.KindProfile, profile(alex, "u3", "Robin")),
	); got.status != http.StatusOK {
		t.Fatalf("a third after deleting one: %d %v", got.status, got.body)
	}
}

func TestADeletedProfileOrConnectionStaysDeleted(t *testing.T) {
	h := start(t, options{})
	alex := h.signUp("alex", nil)
	if got := h.batch(alex,
		put(records.KindProfile, tombstone(alex, records.KindProfile, "u1", nil)),
		put(records.KindConnection, tombstone(alex, records.KindConnection, "c1", nil)),
	); got.status != http.StatusOK {
		t.Fatalf("tombstones: %d %v", got.status, got.body)
	}
	for i, write := range []map[string]any{
		put(records.KindProfile, profile(alex, "u1", "Alex")),
		put(records.KindConnection, connection(alex, "c1", []string{}, map[string]any{})),
	} {
		index, codes := refusal(t, h.batch(alex, write))
		if index != "0" || !slices.Contains(codes, "foyer_deleted") {
			t.Fatalf("un-deleting %d: %s %v", i, index, codes)
		}
	}
}

func TestAPinOrPreferenceCanBeDeletedAndSetAgain(t *testing.T) {
	h := start(t, options{})
	alex := h.signUp("alex", nil)
	parent := map[string]any{"profile": records.ID(alex.id, records.KindProfile, "u1")}
	for _, round := range [][]map[string]any{
		{put(records.KindProfile, profile(alex, "u1", "Alex")), put(records.KindPin, pin(alex, "u1", "1234"))},
		{put(records.KindPin, tombstone(alex, records.KindPin, "u1", parent))},
		{put(records.KindPin, pin(alex, "u1", "4321"))},
	} {
		if got := h.batch(alex, round...); got.status != http.StatusOK {
			t.Fatalf("%d %v", got.status, got.body)
		}
	}
	if got := h.items(alex, records.KindPin); len(got) != 1 || got[0]["pin"] != "4321" || got[0]["deleted"] != false {
		t.Fatalf("the PIN set again: %v", got)
	}
}

func TestATombstoneKeepsNothingButWhoItIs(t *testing.T) {
	h := start(t, options{})
	alex := h.signUp("alex", nil)
	if got := h.batch(alex, put(records.KindConnection, connection(alex, "c1", []string{"password"}, map[string]any{"password": "correct horse"}))); got.status != http.StatusOK {
		t.Fatalf("%d %v", got.status, got.body)
	}
	// Whatever else the write carries.
	dead := connection(alex, "c1", []string{"password"}, map[string]any{"password": "correct horse"})
	dead["deleted"] = true
	if got := h.batch(alex, put(records.KindConnection, dead)); got.status != http.StatusOK {
		t.Fatalf("%d %v", got.status, got.body)
	}
	stored := h.items(alex, records.KindConnection)[0]
	if stored["secrets"] != nil || stored["label"] != "" || stored["plugin_id"] != "" || stored["key"] != "c1" {
		t.Fatalf("a tombstone kept its data: %v", stored)
	}
}

func TestAPasswordListedWithoutItsValueKeepsTheStoredOne(t *testing.T) {
	h := start(t, options{})
	alex := h.signUp("alex", nil)
	write := func(keys []string, secrets map[string]any) {
		t.Helper()
		if got := h.batch(alex, put(records.KindConnection, connection(alex, "c1", keys, secrets))); got.status != http.StatusOK {
			t.Fatalf("%d %v", got.status, got.body)
		}
	}
	secretsOf := func() map[string]any {
		secrets, _ := h.items(alex, records.KindConnection)[0]["secrets"].(map[string]any)
		return secrets
	}

	write([]string{"password", "apiKey"}, map[string]any{"password": "correct horse", "apiKey": "k1"})
	// A device without the password — a phone restored without its keychain — writes the rest.
	write([]string{"password", "apiKey"}, map[string]any{"apiKey": "k2"})
	if got := secretsOf(); got["password"] != "correct horse" || got["apiKey"] != "k2" {
		t.Fatalf("kept: %v", got)
	}
	// A name no longer listed drops its value.
	write([]string{"apiKey"}, map[string]any{})
	if got := secretsOf(); len(got) != 1 || got["apiKey"] != "k2" {
		t.Fatalf("dropped: %v", got)
	}
}

func TestAccountDataIsNeverDeletedButWithTheAccount(t *testing.T) {
	h := start(t, options{})
	alex := h.signUp("alex", map[string]any{"firstProfile": true})
	id := h.items(alex, records.KindProfile)[0]["id"].(string)

	// Not by the device, not by a superuser.
	if got := h.call(http.MethodDelete, "/api/collections/profiles/records/"+id, alex.token, nil); got.status != http.StatusForbidden {
		t.Fatalf("a device's delete: %d", got.status)
	}
	superusers, err := h.app.FindCollectionByNameOrId(core.CollectionNameSuperusers)
	if err != nil {
		t.Fatal(err)
	}
	admin := core.NewRecord(superusers)
	admin.SetEmail("admin@example.com")
	admin.SetPassword("a long password")
	if err := h.app.Save(admin); err != nil {
		t.Fatal(err)
	}
	token, err := admin.NewAuthToken()
	if err != nil {
		t.Fatal(err)
	}
	if got := h.call(http.MethodDelete, "/api/collections/profiles/records/"+id, token, nil); got.status != http.StatusForbidden {
		t.Fatalf("a superuser's delete: %d", got.status)
	}

	// Deleting the account takes everything of it.
	user, err := h.app.FindRecordById("users", alex.id)
	if err != nil {
		t.Fatal(err)
	}
	if err := h.app.Delete(user); err != nil {
		t.Fatal(err)
	}
	if left, err := h.app.CountRecords("profiles"); err != nil || left != 0 {
		t.Fatalf("after the account went: %d profiles, %v", left, err)
	}
}

// --- Sessions -----------------------------------------------------------------

func TestASessionLastsThirtyDays(t *testing.T) {
	h := start(t, options{})
	alex := h.signUp("alex", nil)
	claims := claimsOf(t, alex.token)
	lasts := time.Until(time.Unix(int64(claims["exp"].(float64)), 0))
	if lasts < 30*24*time.Hour-time.Minute || lasts > 30*24*time.Hour+time.Minute {
		t.Fatalf("a session lasts %s", lasts)
	}
	refreshed := h.call(http.MethodPost, "/api/collections/users/auth-refresh", alex.token, nil)
	if refreshed.status != http.StatusOK || refreshed.body["token"] == "" {
		t.Fatalf("refresh: %d %v", refreshed.status, refreshed.body)
	}
}

func TestAPasswordChangeEndsEverySession(t *testing.T) {
	h := start(t, options{})
	alex := h.signUp("alex", nil)
	user, err := h.app.FindRecordById("users", alex.id)
	if err != nil {
		t.Fatal(err)
	}
	// As the dashboard does it: PocketBase moves the token key along.
	user.SetPassword("another long password")
	if err := h.app.Save(user); err != nil {
		t.Fatal(err)
	}
	if got := h.list(alex, records.KindProfile); got.status != http.StatusUnauthorized {
		t.Fatalf("the old session still reads: %d", got.status)
	}
	if got := h.call(http.MethodPost, "/api/collections/users/auth-refresh", alex.token, nil); got.status != http.StatusUnauthorized {
		t.Fatalf("the old session still refreshes: %d", got.status)
	}
	if got := h.signIn("alex", "a long password"); got.status != http.StatusBadRequest {
		t.Fatalf("the old password still signs in: %d", got.status)
	}
	if got := h.signIn("alex", "another long password"); got.status != http.StatusOK {
		t.Fatalf("the new password: %d", got.status)
	}
}

func TestSigningInIsThrottledPerAddress(t *testing.T) {
	h := start(t, options{limits: true})
	h.signUp("alex", nil)
	statuses := []int{}
	for i := 0; i < 6; i++ {
		statuses = append(statuses, h.signIn("alex", "wrong password").status)
	}
	if statuses[4] != http.StatusBadRequest || statuses[5] != http.StatusTooManyRequests {
		t.Fatalf("sign-ins from one address: %v", statuses)
	}
}

func TestSigningUpIsThrottledPerAddress(t *testing.T) {
	h := start(t, options{cfg: config.Config{SignUp: config.SignUpClosed}, limits: true})
	statuses := []int{}
	for i := 0; i < 6; i++ {
		statuses = append(statuses, h.call(http.MethodPost, "/api/foyer/sign-up", "", map[string]any{"username": "alex", "password": "a long password"}).status)
	}
	if statuses[4] != http.StatusForbidden || statuses[5] != http.StatusTooManyRequests {
		t.Fatalf("sign-ups from one address: %v", statuses)
	}
}

func TestAWholeAccountFitsOneBatch(t *testing.T) {
	h := start(t, options{limits: true})
	alex := h.signUp("alex", nil)
	writes := []map[string]any{}
	for p := 0; p < config.DefaultMaxProfiles; p++ {
		key := "u" + string(rune('a'+p))
		writes = append(writes, put(records.KindProfile, profile(alex, key, "Profile")), put(records.KindPin, pin(alex, key, "1234")))
	}
	for c := 0; c < 40; c++ {
		writes = append(writes, put(records.KindConnection, connection(alex, "c"+strings.Repeat("x", c), []string{}, map[string]any{})))
	}
	if got := h.batch(alex, writes...); got.status != http.StatusOK {
		t.Fatalf("%d writes: %d %v", len(writes), got.status, got.body)
	}
}

// --- The shared fixtures -------------------------------------------------------

// Every record the api accepts, the server stores; every one it refuses and a
// device could still send, the server refuses.
func TestTheServerJudgesTheSharedFixturesAsTheApiDoes(t *testing.T) {
	f, err := fixtures.Load()
	if err != nil {
		t.Fatal(err)
	}
	h := start(t, options{})
	for i, record := range f.Valid {
		alex := h.signUp("valid"+letters(i), nil)
		kind, _, body, ok := fixtures.ToBody(alex.id, record)
		if !ok {
			t.Fatalf("%v cannot be sent", record)
		}
		writes := append(parentsOf(alex, kind, body["key"].(string), body), put(kind, body))
		if got := h.batch(alex, writes...); got.status != http.StatusOK {
			t.Errorf("refused %v: %d %v", record, got.status, got.body)
		}
	}
	for i, fixture := range f.Invalid {
		alex := h.signUp("invalid"+letters(i), nil)
		kind, _, body, ok := fixtures.ToBody(alex.id, fixture.Record)
		if !ok {
			continue // the plugin never sends it
		}
		key, _ := body["key"].(string)
		writes := append(parentsOf(alex, kind, key, body), put(kind, body))
		if got := h.batch(alex, writes...); got.status != http.StatusBadRequest {
			t.Errorf("stored %s: %d", fixture.Why, got.status)
		}
	}
}

// letters names the nth account of a run in letters alone, which a username
// takes, however many fixtures there are: aa, ab, … az, ba.
func letters(n int) string {
	return string(rune('a'+n/26)) + string(rune('a'+n%26))
}

// parentsOf writes the live parents a child's key names, so it is the child alone that is judged.
func parentsOf(who account, kind, key string, body map[string]any) []map[string]any {
	parts := strings.SplitN(key, "/", 2)
	switch kind {
	case records.KindPin, records.KindPreference, records.KindWatchProgress:
		return []map[string]any{put(records.KindProfile, profile(who, parts[0], "Parent"))}
	case records.KindProfileValues:
		if len(parts) < 2 {
			return nil
		}
		return []map[string]any{
			put(records.KindConnection, connection(who, parts[0], []string{}, map[string]any{})),
			put(records.KindProfile, profile(who, parts[1], "Parent")),
		}
	case records.KindSubscription, records.KindFavoriteChannel, records.KindPlaylist:
		// Their key is a generated id, so the parents are named in the body.
		writes := []map[string]any{}
		if profileKey, ok := body["profile_key"].(string); ok && profileKey != "" {
			writes = append(writes, put(records.KindProfile, profile(who, profileKey, "Parent")))
		}
		if connectionKey, ok := body["connection_key"].(string); ok && connectionKey != "" {
			writes = append(writes, put(records.KindConnection, connection(who, connectionKey, []string{}, map[string]any{})))
		}
		return writes
	}
	return nil
}

func claimsOf(t *testing.T, token string) map[string]any {
	t.Helper()
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		t.Fatalf("not a token: %q", token)
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		t.Fatal(err)
	}
	var claims map[string]any
	if err := json.Unmarshal(raw, &claims); err != nil {
		t.Fatal(err)
	}
	return claims
}
