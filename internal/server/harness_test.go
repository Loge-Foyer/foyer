package server_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"

	"foyer/internal/config"
	"foyer/internal/records"
	"foyer/internal/server"
	_ "foyer/migrations"
)

// harness is the server on a temporary data directory: PocketBase with this
// server's migrations, hooks and routes, called through its real router.
type harness struct {
	t   *testing.T
	app *tests.TestApp
	mux http.Handler
}

type options struct {
	cfg config.Config
	// Most tests sign in more often than the limiter lets one address.
	limits bool
}

func start(t *testing.T, opts options) *harness {
	t.Helper()
	if opts.cfg.MaxProfiles == 0 {
		opts.cfg.MaxProfiles = config.DefaultMaxProfiles
	}
	if opts.cfg.SignUp == "" {
		opts.cfg.SignUp = config.SignUpOpen
	}
	app, err := tests.NewTestAppWithConfig(core.BaseAppConfig{DataDir: t.TempDir(), EncryptionEnv: "pb_test_env"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Cleanup)
	if !opts.limits {
		app.Settings().RateLimits.Enabled = false
	}
	server.Bind(app, opts.cfg)

	router, err := apis.NewRouter(app)
	if err != nil {
		t.Fatal(err)
	}
	var mux http.Handler
	serve := &core.ServeEvent{App: app, Router: router}
	if err := app.OnServe().Trigger(serve, func(e *core.ServeEvent) error {
		built, err := e.Router.BuildMux()
		mux = built
		return err
	}); err != nil {
		t.Fatal(err)
	}
	return &harness{t: t, app: app, mux: mux}
}

type answer struct {
	status int
	body   map[string]any
	list   []any
}

func (h *harness) call(method, path, token string, body any) answer {
	h.t.Helper()
	var payload []byte
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			h.t.Fatal(err)
		}
		payload = encoded
	}
	request := httptest.NewRequest(method, path, bytes.NewReader(payload))
	request.Header.Set("Content-Type", "application/json")
	if token != "" {
		request.Header.Set("Authorization", token)
	}
	recorder := httptest.NewRecorder()
	h.mux.ServeHTTP(recorder, request)

	result := answer{status: recorder.Code}
	raw := recorder.Body.Bytes()
	if len(raw) > 0 && raw[0] == '[' {
		_ = json.Unmarshal(raw, &result.list)
	} else if len(raw) > 0 {
		_ = json.Unmarshal(raw, &result.body)
	}
	return result
}

// fetch answers a GET as it was sent, for what is not JSON. It asks for no
// compression, so the body is what the dashboard's routes serve.
func (h *harness) fetch(path string) (int, http.Header, []byte) {
	h.t.Helper()
	recorder := httptest.NewRecorder()
	h.mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))
	return recorder.Code, recorder.Header(), recorder.Body.Bytes()
}

// account is one signed-up account and a session for it.
type account struct {
	id, token, name string
}

func (h *harness) signUp(name string, extra map[string]any) account {
	h.t.Helper()
	body := map[string]any{"username": name, "password": "a long password", "firstProfile": false}
	for key, value := range extra {
		body[key] = value
	}
	got := h.call(http.MethodPost, "/api/foyer/sign-up", "", body)
	if got.status != http.StatusOK {
		h.t.Fatalf("sign-up of %s: %d %v", name, got.status, got.body)
	}
	record, _ := got.body["record"].(map[string]any)
	return account{id: record["id"].(string), token: got.body["token"].(string), name: name}
}

func (h *harness) signIn(name, password string) answer {
	h.t.Helper()
	return h.call(http.MethodPost, "/api/collections/users/auth-with-password", "", map[string]any{"identity": name, "password": password})
}

// put is one upsert of a batch, as the plugin writes it.
func put(kind string, body map[string]any) map[string]any {
	collection, _ := records.Collection(kind)
	return map[string]any{"method": http.MethodPut, "url": "/api/collections/" + collection + "/records", "body": body}
}

func (h *harness) batch(who account, requests ...map[string]any) answer {
	h.t.Helper()
	return h.call(http.MethodPost, "/api/batch", who.token, map[string]any{"requests": requests})
}

// list reads a collection whole, as a pull does.
func (h *harness) list(who account, kind string) answer {
	h.t.Helper()
	collection, _ := records.Collection(kind)
	return h.call(http.MethodGet, "/api/collections/"+collection+"/records?page=1&perPage=1000&sort=id&skipTotal=1", who.token, nil)
}

func (h *harness) items(who account, kind string) []map[string]any {
	h.t.Helper()
	got := h.list(who, kind)
	if got.status != http.StatusOK {
		h.t.Fatalf("list %s: %d %v", kind, got.status, got.body)
	}
	raw, _ := got.body["items"].([]any)
	items := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		items = append(items, item.(map[string]any))
	}
	return items
}

// The bodies of a well-formed account, derived as the plugin derives them.

func profile(who account, key, name string) map[string]any {
	return map[string]any{
		"id": records.ID(who.id, records.KindProfile, key), "user": who.id, "key": key, "deleted": false, "name": name,
	}
}

func pin(who account, key, value string) map[string]any {
	return map[string]any{
		"id": records.ID(who.id, records.KindPin, key), "user": who.id, "key": key, "deleted": false,
		"profile": records.ID(who.id, records.KindProfile, key), "pin": value,
	}
}

func connection(who account, key string, secretKeys []string, secrets map[string]any) map[string]any {
	return map[string]any{
		"id": records.ID(who.id, records.KindConnection, key), "user": who.id, "key": key, "deleted": false,
		"plugin_id": "sources/jellyfin", "label": "Home", "enabled": true, "per_profile": "none",
		"fields": map[string]any{"serverUrl": "http://jellyfin.local:8096"}, "settings": map[string]any{},
		"secret_keys": secretKeys, "secrets": secrets,
	}
}

func tombstone(who account, kind, key string, parents map[string]any) map[string]any {
	body := map[string]any{"id": records.ID(who.id, kind, key), "user": who.id, "key": key, "deleted": true}
	for name, value := range parents {
		body[name] = value
	}
	return body
}

// refusal is the write a failed batch names, and the codes it names it by.
func refusal(t *testing.T, got answer) (index string, codes []string) {
	t.Helper()
	if got.status != http.StatusBadRequest {
		t.Fatalf("expected the batch refused, got %d %v", got.status, got.body)
	}
	data, _ := got.body["data"].(map[string]any)
	requests, _ := data["requests"].(map[string]any)
	for i, entry := range requests {
		response, _ := entry.(map[string]any)["response"].(map[string]any)
		fields, _ := response["data"].(map[string]any)
		for _, field := range fields {
			if code, ok := field.(map[string]any)["code"].(string); ok {
				codes = append(codes, code)
			}
		}
		return i, codes
	}
	t.Fatalf("the refusal names no write: %v", got.body)
	return "", nil
}
