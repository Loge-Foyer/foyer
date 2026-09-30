// Package config reads the server's settings from its environment, once, at
// start. Everything else a household would tune lives in PocketBase's own
// settings, written by the migrations.
package config

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// DefaultMaxProfiles matches DEFAULT_MAX_PROFILES in the api: what an account
// holds unless the server says otherwise.
const DefaultMaxProfiles = 10

// SignUp is how the server takes new accounts.
type SignUp string

const (
	SignUpInvite SignUp = "invite"
	SignUpOpen   SignUp = "open"
	SignUpClosed SignUp = "closed"
)

type Config struct {
	MaxProfiles   int
	SignUp        SignUp
	AdminEmail    string
	AdminPassword string
	// TrustProxy names the header a reverse proxy puts the caller's address in.
	// Empty without a proxy: then anyone could send it and claim any address.
	TrustProxy string
}

var header = regexp.MustCompile(`^[A-Za-z0-9-]+$`)

// FromEnv reads SC_MAX_PROFILES, SC_SIGNUP, SC_ADMIN_EMAIL, SC_ADMIN_PASSWORD
// and SC_TRUST_PROXY, refusing a value it cannot use rather than guessing.
func FromEnv(get func(string) string) (Config, error) {
	cfg := Config{
		MaxProfiles:   DefaultMaxProfiles,
		SignUp:        SignUpInvite,
		AdminEmail:    strings.TrimSpace(get("SC_ADMIN_EMAIL")),
		AdminPassword: get("SC_ADMIN_PASSWORD"),
		TrustProxy:    strings.TrimSpace(get("SC_TRUST_PROXY")),
	}

	if raw := strings.TrimSpace(get("SC_MAX_PROFILES")); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > 100 {
			return Config{}, fmt.Errorf("SC_MAX_PROFILES must be a whole number from 1 to 100, not %q", raw)
		}
		cfg.MaxProfiles = n
	}

	if raw := strings.TrimSpace(get("SC_SIGNUP")); raw != "" {
		switch SignUp(raw) {
		case SignUpInvite, SignUpOpen, SignUpClosed:
			cfg.SignUp = SignUp(raw)
		default:
			return Config{}, fmt.Errorf("SC_SIGNUP must be invite, open or closed, not %q", raw)
		}
	}

	if (cfg.AdminEmail == "") != (cfg.AdminPassword == "") {
		return Config{}, fmt.Errorf("SC_ADMIN_EMAIL and SC_ADMIN_PASSWORD go together")
	}

	if cfg.TrustProxy != "" && !header.MatchString(cfg.TrustProxy) {
		return Config{}, fmt.Errorf("SC_TRUST_PROXY must be a header name, such as X-Forwarded-For, not %q", cfg.TrustProxy)
	}

	return cfg, nil
}
