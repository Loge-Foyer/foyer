// Foyer's icon wherever PocketBase's dashboard would show its own: the
// browser's tab, the sign-in page and the header. PocketBase pastes this into
// /_/extensions.js and loads it as the dashboard starts.
if (window.app?.store) {
  const icon = './extensions/foyer/icon.png';
  app.store.favicon = icon;
  app.store.mainLogo = icon;
  app.store.headerLogo = icon;
}
