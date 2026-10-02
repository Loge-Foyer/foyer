// Package dashboard dresses PocketBase's dashboard as Foyer: its icon in the
// browser's tab, on the sign-in page and in the header.
//
// PocketBase calls this a UI extension, and marks the API experimental. The
// server's tests hold the dashboard to the three fields ui/main.js sets, so an
// upgrade that renames them fails there rather than quietly showing
// PocketBase's icon again.
package dashboard

import (
	"embed"
	"io/fs"

	"github.com/pocketbase/pocketbase/core"
)

//go:embed ui
var files embed.FS

// Extension is served at /_/extensions/foyer/, with its main.js folded into
// /_/extensions.js.
func Extension() (core.UIExtension, error) {
	// PocketBase looks for main.js at the root of the extension: without Sub it
	// finds none, and skips the extension without a word.
	ui, err := fs.Sub(files, "ui")
	if err != nil {
		return core.UIExtension{}, err
	}
	return core.UIExtension{Name: "foyer", FS: ui}, nil
}
