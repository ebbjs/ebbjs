package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
	"time"

	"tailscale.com/ipn/ipnstate"
	"tailscale.com/types/views"
)

func tagSlice(tags ...string) *views.Slice[string] {
	slice := views.SliceOf(tags)
	return &slice
}

func TestRedirectHandlerMovesToTLSWith308(t *testing.T) {
	handler := redirectHandler("https://ebb.tailnet.ts.net")

	request := httptest.NewRequest(http.MethodPost, "http://ebb.tailnet.ts.net/sync/write?x=1", strings.NewReader("body"))
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusPermanentRedirect {
		t.Fatalf("status = %d, want 308", recorder.Code)
	}
	if got, want := recorder.Header().Get("Location"), "https://ebb.tailnet.ts.net/sync/write?x=1"; got != want {
		t.Errorf("Location = %q, want %q", got, want)
	}
}

func TestRunningEventForTaggedNode(t *testing.T) {
	status := &ipnstate.Status{
		TailscaleIPs: []netip.Addr{netip.MustParseAddr("100.64.0.7")},
		Self: &ipnstate.PeerStatus{
			DNSName:   "ebb.tailnet.ts.net.",
			Tags:      tagSlice("tag:ebb"),
			KeyExpiry: nil,
		},
	}

	event, err := runningEventFor(status, true)
	if err != nil {
		t.Fatalf("runningEventFor: %v", err)
	}
	if event.URL != "https://ebb.tailnet.ts.net" {
		t.Errorf("URL = %q", event.URL)
	}
	if event.DNSName != "ebb.tailnet.ts.net" {
		t.Errorf("DNSName = %q, want no trailing dot", event.DNSName)
	}
	if len(event.IPs) != 1 || event.IPs[0] != "100.64.0.7" {
		t.Errorf("IPs = %v", event.IPs)
	}
	if len(event.Tags) != 1 || event.Tags[0] != "tag:ebb" {
		t.Errorf("Tags = %v", event.Tags)
	}
	if event.KeyExpiry != "" {
		t.Errorf("KeyExpiry = %q, want empty for a tagged node", event.KeyExpiry)
	}

	encoded, err := json.Marshal(event)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(encoded), "key_expiry") {
		t.Errorf("encoded event %s contains key_expiry for a tagged node", encoded)
	}
	if !strings.Contains(string(encoded), `"tls":true`) {
		t.Errorf("encoded event %s does not carry tls", encoded)
	}
}

func TestRunningEventForUntaggedNodeCarriesExpiry(t *testing.T) {
	expiry := time.Date(2027, 1, 2, 3, 4, 5, 0, time.UTC)
	status := &ipnstate.Status{
		TailscaleIPs: []netip.Addr{netip.MustParseAddr("100.64.0.8")},
		Self: &ipnstate.PeerStatus{
			DNSName:   "ebb.tailnet.ts.net.",
			Tags:      tagSlice(),
			KeyExpiry: &expiry,
		},
	}

	event, err := runningEventFor(status, false)
	if err != nil {
		t.Fatalf("runningEventFor: %v", err)
	}
	if event.URL != "http://ebb.tailnet.ts.net" {
		t.Errorf("URL = %q", event.URL)
	}
	if event.KeyExpiry != "2027-01-02T03:04:05Z" {
		t.Errorf("KeyExpiry = %q", event.KeyExpiry)
	}
	if len(event.Tags) != 0 || event.Tags == nil {
		t.Errorf("Tags = %#v, want an empty JSON list", event.Tags)
	}
}

func TestControlWarningIsQuietDuringGraceAndDeduped(t *testing.T) {
	start := time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC)
	status := &ipnstate.Status{BackendState: "NeedsLogin"}

	if _, warn := controlWarning(status, start, "", time.Time{}, start.Add(time.Second)); warn {
		t.Fatal("warned inside the startup grace period")
	}

	message, warn := controlWarning(status, start, "", time.Time{}, start.Add(6*time.Second))
	if !warn {
		t.Fatal("did not warn after the grace period")
	}
	if !strings.Contains(message, "control server unreachable") ||
		!strings.Contains(message, "NeedsLogin") {
		t.Errorf("message = %q", message)
	}

	if _, warn := controlWarning(status, start, "NeedsLogin", start.Add(6*time.Second), start.Add(20*time.Second)); warn {
		t.Fatal("repeated the warning inside the interval")
	}
	if _, warn := controlWarning(status, start, "NeedsLogin", start.Add(6*time.Second), start.Add(70*time.Second)); !warn {
		t.Fatal("did not repeat the warning after the interval")
	}

	auth := &ipnstate.Status{BackendState: "NeedsLogin", AuthURL: "https://login.tailscale.com/a/x"}
	if _, warn := controlWarning(auth, start, "", time.Time{}, start.Add(time.Minute)); warn {
		t.Fatal("warned while an interactive login URL is available")
	}
}
