package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func decodeEvents(t *testing.T, buf *bytes.Buffer) []map[string]any {
	t.Helper()
	var events []map[string]any
	for _, line := range strings.Split(strings.TrimRight(buf.String(), "\n"), "\n") {
		if line == "" {
			continue
		}
		var event map[string]any
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			t.Fatalf("decode NDJSON line %q: %v", line, err)
		}
		events = append(events, event)
	}
	return events
}

func TestNotifyAuthURLEmitsLoginOncePerURL(t *testing.T) {
	var out bytes.Buffer
	emitter := newEmitter(&out, false)

	emitter.notifyAuthURL("https://login.tailscale.com/a/first")
	emitter.notifyAuthURL("https://login.tailscale.com/a/first")
	emitter.notifyAuthURL("")
	emitter.notifyAuthURL("https://login.tailscale.com/a/second")

	events := decodeEvents(t, &out)
	if len(events) != 2 {
		t.Fatalf("got %d events, want 2: %v", len(events), events)
	}
	for i, want := range []string{
		"https://login.tailscale.com/a/first",
		"https://login.tailscale.com/a/second",
	} {
		if events[i]["event"] != "login" {
			t.Errorf("event[%d] = %v, want login", i, events[i]["event"])
		}
		if events[i]["url"] != want {
			t.Errorf("event[%d].url = %v, want %s", i, events[i]["url"], want)
		}
	}
}

func TestNotifyAuthURLEmitsQROncePerURL(t *testing.T) {
	var out bytes.Buffer
	emitter := newEmitter(&out, true)
	url := "https://login.tailscale.com/a/with-qr"

	emitter.notifyAuthURL(url)
	emitter.notifyAuthURL(url)

	events := decodeEvents(t, &out)
	if len(events) != 2 {
		t.Fatalf("got %d events, want login + qr: %v", len(events), events)
	}
	if events[0]["event"] != "login" || events[1]["event"] != "qr" {
		t.Fatalf("events = %v, want login then qr", events)
	}
	if events[1]["url"] != url {
		t.Errorf("qr url = %v, want %s", events[1]["url"], url)
	}

	lines, ok := events[1]["lines"].([]any)
	if !ok || len(lines) < 5 {
		t.Fatalf("qr lines = %#v, want a rendered code", events[1]["lines"])
	}
	for _, line := range lines {
		text, _ := line.(string)
		if strings.Contains(text, "\x1b") {
			t.Errorf("qr line %q contains an ANSI escape", text)
		}
	}
}

func TestNotifyAuthURLSuppressesQRWhenDisabled(t *testing.T) {
	var out bytes.Buffer
	emitter := newEmitter(&out, false)

	emitter.notifyAuthURL("https://login.tailscale.com/a/no-qr")

	events := decodeEvents(t, &out)
	if len(events) != 1 || events[0]["event"] != "login" {
		t.Fatalf("events = %v, want a single login", events)
	}
}

func TestQRLinesRenderHalfBlocks(t *testing.T) {
	lines := qrLines("https://login.tailscale.com/a/render")
	if len(lines) < 5 {
		t.Fatalf("got %d lines, want a rendered code", len(lines))
	}

	rendered := strings.Join(lines, "\n")
	if !strings.ContainsAny(rendered, "▀▄█") {
		t.Errorf("rendered QR has no half-block characters: %q", rendered)
	}
	if strings.Contains(rendered, "\x1b") {
		t.Error("rendered QR contains ANSI escapes")
	}
}
