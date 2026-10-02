package config

import (
	"strings"
	"testing"
)

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
		"FOYER_MAX_PROFILES":   "4",
		"FOYER_SIGNUP":         "open",
		"FOYER_ADMIN_EMAIL":    "admin@example.com",
		"FOYER_ADMIN_PASSWORD": "a long password",
		"FOYER_TRUST_PROXY":    "X-Forwarded-For",
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
		"a limit that is not a number": {"FOYER_MAX_PROFILES": "ten"},
		"no profiles at all":           {"FOYER_MAX_PROFILES": "0"},
		"an unknown sign-up mode":      {"FOYER_SIGNUP": "anyone"},
		"an email without a password":  {"FOYER_ADMIN_EMAIL": "admin@example.com"},
		"a proxy header that is not":   {"FOYER_TRUST_PROXY": "X-Forwarded-For: 1.2.3.4"},
	} {
		if _, err := FromEnv(env(values)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestRefusesTheNamesFromBeforeFoyer(t *testing.T) {
	for _, old := range []string{"SC_MAX_PROFILES", "SC_SIGNUP", "SC_ADMIN_EMAIL", "SC_ADMIN_PASSWORD", "SC_TRUST_PROXY", "SC_PUBLISH"} {
		_, err := FromEnv(env(map[string]string{old: "anything"}))
		if err == nil {
			t.Errorf("%s: accepted", old)
			continue
		}
		if want := "FOYER_" + old[len("SC_"):]; !strings.Contains(err.Error(), want) {
			t.Errorf("%s: %q does not name %s", old, err, want)
		}
	}
}
