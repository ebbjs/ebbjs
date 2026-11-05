package main

import (
	"io"
	"strings"
	"testing"
)

func mustParseConfig(t *testing.T, line string) Config {
	t.Helper()
	cfg, err := parseConfig([]byte(line))
	if err != nil {
		t.Fatalf("parseConfig(%s): %v", line, err)
	}
	return cfg
}

func TestParseConfigMinimalDefaults(t *testing.T) {
	cfg := mustParseConfig(t, `{"state_dir":"/state","backend_addr":"127.0.0.1:4000"}`)

	if cfg.Hostname != defaultHostname {
		t.Errorf("Hostname = %q, want %q", cfg.Hostname, defaultHostname)
	}
	if cfg.HTTPS != httpsAuto {
		t.Errorf("HTTPS = %q, want %q", cfg.HTTPS, httpsAuto)
	}
	if cfg.AuthKey != "" || cfg.ControlURL != "" {
		t.Errorf("AuthKey/ControlURL = %q/%q, want empty", cfg.AuthKey, cfg.ControlURL)
	}
	if cfg.Tags == nil || len(cfg.Tags) != 0 {
		t.Errorf("Tags = %#v, want empty non-nil", cfg.Tags)
	}
	if cfg.QR {
		t.Error("QR = true, want false")
	}
}

func TestParseConfigFull(t *testing.T) {
	cfg := mustParseConfig(t, `{
		"state_dir":"/app/data/tailscale",
		"hostname":"ebb",
		"auth_key":"tskey-abc",
		"control_url":"https://headscale.example.com",
		"tags":["tag:ebb"],
		"https":"on",
		"backend_addr":"127.0.0.1:4000",
		"proxy_secret":"secret",
		"qr":true
	}`)

	if cfg.StateDir != "/app/data/tailscale" {
		t.Errorf("StateDir = %q", cfg.StateDir)
	}
	if cfg.AuthKey != "tskey-abc" {
		t.Errorf("AuthKey = %q", cfg.AuthKey)
	}
	if cfg.ControlURL != "https://headscale.example.com" {
		t.Errorf("ControlURL = %q", cfg.ControlURL)
	}
	if len(cfg.Tags) != 1 || cfg.Tags[0] != "tag:ebb" {
		t.Errorf("Tags = %#v", cfg.Tags)
	}
	if cfg.HTTPS != httpsOn {
		t.Errorf("HTTPS = %q, want %q", cfg.HTTPS, httpsOn)
	}
	if cfg.BackendAddr != "127.0.0.1:4000" {
		t.Errorf("BackendAddr = %q", cfg.BackendAddr)
	}
	if cfg.ProxySecret != "secret" {
		t.Errorf("ProxySecret = %q", cfg.ProxySecret)
	}
	if !cfg.QR {
		t.Error("QR = false, want true")
	}
}

func TestParseConfigHTTPSModes(t *testing.T) {
	for raw, want := range map[string]string{
		"":       httpsAuto,
		"auto":   httpsAuto,
		" AUTO ": httpsAuto,
		"on":     httpsOn,
		"off":    httpsOff,
		"OFF":    httpsOff,
	} {
		got, err := parseHTTPSMode(raw)
		if err != nil {
			t.Errorf("parseHTTPSMode(%q): %v", raw, err)
			continue
		}
		if got != want {
			t.Errorf("parseHTTPSMode(%q) = %q, want %q", raw, got, want)
		}
	}
}

func TestParseConfigRejectsInvalidInput(t *testing.T) {
	cases := map[string]struct {
		line string
		want string
	}{
		"invalid https": {
			line: `{"state_dir":"/state","backend_addr":"127.0.0.1:4000","https":"sometimes"}`,
			want: "https must be auto, on, or off",
		},
		"missing state dir": {
			line: `{"backend_addr":"127.0.0.1:4000"}`,
			want: "state_dir is required",
		},
		"missing backend": {
			line: `{"state_dir":"/state"}`,
			want: "backend_addr is required",
		},
		"backend without port": {
			line: `{"state_dir":"/state","backend_addr":"127.0.0.1"}`,
			want: "backend_addr",
		},
		"not json": {
			line: `not json`,
			want: "config:",
		},
	}

	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := parseConfig([]byte(tc.line))
			if err == nil {
				t.Fatalf("parseConfig(%s) succeeded, want error", tc.line)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("error = %q, want it to contain %q", err, tc.want)
			}
		})
	}
}

func TestReadConfigConsumesOneLine(t *testing.T) {
	stdin := strings.NewReader(`{"state_dir":"/state","backend_addr":"127.0.0.1:4000"}` + "\nignored\n")

	cfg, rest, err := readConfig(stdin)
	if err != nil {
		t.Fatalf("readConfig: %v", err)
	}
	if cfg.StateDir != "/state" {
		t.Errorf("StateDir = %q", cfg.StateDir)
	}

	buffered, err := io.ReadAll(rest)
	if err != nil {
		t.Fatalf("read rest: %v", err)
	}
	if string(buffered) != "ignored\n" {
		t.Errorf("rest = %q, want %q", buffered, "ignored\n")
	}
}

func TestReadConfigRejectsEmptyStdin(t *testing.T) {
	if _, _, err := readConfig(strings.NewReader("")); err == nil {
		t.Fatal("readConfig() succeeded on empty stdin, want error")
	}
}
