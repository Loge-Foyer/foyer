package config

import "testing"

func env(values map[string]string) func(string) string {
	return func(key string) string { return values[key] }
}

func TestDefaults(t *testing.T) {
	cfg, err := FromEnv(env(nil))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.MaxProfiles != 10 || cfg.SignUp != SignUpInvite || cfg.TrustProxy != "" {
		t.Fatalf("unexpected defaults: %+v", cfg)
	}
}

func TestReadsEveryVariable(t *testing.T) {
	cfg, err := FromEnv(env(map[string]string{
		"SC_MAX_PROFILES":   "4",
		"SC_SIGNUP":         "open",
		"SC_ADMIN_EMAIL":    "admin@example.com",
		"SC_ADMIN_PASSWORD": "a long password",
		"SC_TRUST_PROXY":    "X-Forwarded-For",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.MaxProfiles != 4 || cfg.SignUp != SignUpOpen || cfg.AdminEmail != "admin@example.com" || cfg.TrustProxy != "X-Forwarded-For" {
		t.Fatalf("unexpected config: %+v", cfg)
	}
}

func TestRefusesWhatItCannotUse(t *testing.T) {
	for name, values := range map[string]map[string]string{
		"a limit that is not a number": {"SC_MAX_PROFILES": "ten"},
		"no profiles at all":           {"SC_MAX_PROFILES": "0"},
		"an unknown sign-up mode":      {"SC_SIGNUP": "anyone"},
		"an email without a password":  {"SC_ADMIN_EMAIL": "admin@example.com"},
		"a proxy header that is not":   {"SC_TRUST_PROXY": "X-Forwarded-For: 1.2.3.4"},
	} {
		if _, err := FromEnv(env(values)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}
