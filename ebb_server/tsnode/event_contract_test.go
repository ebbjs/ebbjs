package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

// `testdata/events.ndjson` is the event vocabulary the BEAM parses in
// `EbbServer.Tailscale.Node`. The Elixir suite feeds the same file through its
// gateway fixture, so a rename or a dropped field on either side fails a test
// instead of leaving an operator with a silent node.
const eventTranscriptPath = "testdata/events.ndjson"

func readEventTranscript(t *testing.T) []string {
	t.Helper()

	data, err := os.ReadFile(eventTranscriptPath)
	if err != nil {
		t.Fatalf("read %s: %v", eventTranscriptPath, err)
	}

	var lines []string
	scanner := bufio.NewScanner(bytes.NewReader(data))
	for scanner.Scan() {
		if line := scanner.Text(); line != "" {
			lines = append(lines, line)
		}
	}
	if err := scanner.Err(); err != nil {
		t.Fatalf("scan %s: %v", eventTranscriptPath, err)
	}
	return lines
}

func splitLines(output []byte) []string {
	var lines []string
	scanner := bufio.NewScanner(bytes.NewReader(output))
	for scanner.Scan() {
		lines = append(lines, scanner.Text())
	}
	return lines
}

func TestEmitterOutputMatchesEventTranscript(t *testing.T) {
	transcript := readEventTranscript(t)

	// One line per event type the node handles; a new event has to be added
	// here and to the Elixir parser deliberately.
	var events []string
	for _, line := range transcript {
		var envelope struct {
			Event string `json:"event"`
		}
		if err := json.Unmarshal([]byte(line), &envelope); err != nil {
			t.Fatalf("parse transcript line %q: %v", line, err)
		}
		events = append(events, envelope.Event)
	}
	if want := []string{"login", "qr", "running", "error"}; !reflect.DeepEqual(events, want) {
		t.Fatalf("transcript events = %v, want %v", events, want)
	}

	var out bytes.Buffer
	emitter := newEmitter(&out, true)

	// Twice, because control re-reports the same auth URL while the node waits.
	emitter.notifyAuthURL("https://login.tailscale.com/a/abc123")
	emitter.notifyAuthURL("https://login.tailscale.com/a/abc123")
	emitter.write(runningEvent{
		Event:     "running",
		URL:       "https://ebb.example.ts.net",
		DNSName:   "ebb.example.ts.net",
		IPs:       []string{"100.64.0.1", "fd7a:115c:a1e0::1"},
		TLS:       true,
		Tags:      []string{"tag:ebb"},
		KeyExpiry: "2027-01-02T03:04:05Z",
	})
	emitter.write(errorEvent{Event: "error", Message: "control server unreachable"})

	got := splitLines(out.Bytes())
	if len(got) != len(transcript) {
		t.Fatalf("emitted %d lines, transcript has %d:\n%s", len(got), len(transcript), out.String())
	}

	// login, running and error are byte-for-byte the contract.
	for _, index := range []int{0, 2, 3} {
		if got[index] != transcript[index] {
			t.Errorf("line %d = %s, want %s", index, got[index], transcript[index])
		}
	}

	// The QR envelope is the contract; its rendered lines belong to
	// qrterminal, so only the keys and the URL are compared.
	var emittedQR map[string]json.RawMessage
	if err := json.Unmarshal([]byte(got[1]), &emittedQR); err != nil {
		t.Fatalf("parse emitted qr line: %v", err)
	}
	var contractQR map[string]json.RawMessage
	if err := json.Unmarshal([]byte(transcript[1]), &contractQR); err != nil {
		t.Fatalf("parse contract qr line: %v", err)
	}
	for key := range contractQR {
		if _, present := emittedQR[key]; !present {
			t.Errorf("qr event is missing contract field %q", key)
		}
	}
	for key := range emittedQR {
		if _, present := contractQR[key]; !present {
			t.Errorf("qr event has field %q that the BEAM does not read", key)
		}
	}
	if string(emittedQR["url"]) != string(contractQR["url"]) {
		t.Errorf("qr url = %s, want %s", emittedQR["url"], contractQR["url"])
	}
}
