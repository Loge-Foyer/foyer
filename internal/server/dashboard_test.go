package server_test

import (
	"bytes"
	"io/fs"
	"net/http"
	"testing"

	"github.com/pocketbase/pocketbase/ui"
)

func TestTheDashboardWearsFoyersIcon(t *testing.T) {
	h := start(t, options{})
	status, _, script := h.fetch("/_/extensions.js")
	if status != http.StatusOK || !bytes.Contains(script, []byte("./extensions/foyer/icon.png")) {
		t.Fatalf("extensions.js: %d %q", status, script)
	}
	status, header, icon := h.fetch("/_/extensions/foyer/icon.png")
	if status != http.StatusOK || header.Get("Content-Type") != "image/png" || !bytes.HasPrefix(icon, []byte("\x89PNG")) {
		t.Fatalf("icon: %d %q, %d bytes", status, header.Get("Content-Type"), len(icon))
	}
}

// PocketBase marks UI extensions experimental. Should its dashboard stop
// reading what Foyer's main.js sets, this fails, instead of the dashboard
// quietly showing PocketBase's icon again.
func TestTheDashboardStillReadsWhatFoyerSets(t *testing.T) {
	scripts, err := fs.Glob(ui.DistDirFS, "assets/*.js")
	if err != nil || len(scripts) == 0 {
		t.Fatalf("PocketBase's dashboard has no scripts: %v %v", scripts, err)
	}
	var bundle []byte
	for _, name := range scripts {
		code, err := fs.ReadFile(ui.DistDirFS, name)
		if err != nil {
			t.Fatal(err)
		}
		bundle = append(bundle, code...)
	}
	for _, want := range []string{"app.store.favicon", "app.store.mainLogo", "app.store.headerLogo", "/_/extensions.js"} {
		if !bytes.Contains(bundle, []byte(want)) {
			t.Errorf("PocketBase's dashboard no longer mentions %s", want)
		}
	}
}
