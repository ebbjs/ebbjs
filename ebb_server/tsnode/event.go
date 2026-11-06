package main

import (
	"encoding/json"
	"io"
	"strings"
	"sync"

	"github.com/mdp/qrterminal/v3"
)

type loginEvent struct {
	Event string `json:"event"`
	URL   string `json:"url"`
}

type qrEvent struct {
	Event string   `json:"event"`
	URL   string   `json:"url"`
	Lines []string `json:"lines"`
}

type runningEvent struct {
	Event     string   `json:"event"`
	URL       string   `json:"url"`
	DNSName   string   `json:"dns_name"`
	IPs       []string `json:"ips"`
	TLS       bool     `json:"tls"`
	Tags      []string `json:"tags"`
	KeyExpiry string   `json:"key_expiry,omitempty"`
}

type errorEvent struct {
	Event   string `json:"event"`
	Message string `json:"message"`
}

// emitter publishes NDJSON on stdout. Control re-reports the same auth URL
// while a node waits for authorization, so both the login line and its QR are
// deduplicated by URL.
type emitter struct {
	mu     sync.Mutex
	enc    *json.Encoder
	qr     bool
	logins map[string]struct{}
	qrs    map[string]struct{}
}

func newEmitter(w io.Writer, qr bool) *emitter {
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	return &emitter{
		enc:    enc,
		qr:     qr,
		logins: make(map[string]struct{}),
		qrs:    make(map[string]struct{}),
	}
}

// write drops its error: a failed stdout write means the BEAM is gone, and
// stdin EOF is the signal that shuts this process down.
func (e *emitter) write(event any) {
	e.mu.Lock()
	defer e.mu.Unlock()
	_ = e.enc.Encode(event)
}

func (e *emitter) notifyAuthURL(url string) {
	if url == "" {
		return
	}

	e.mu.Lock()
	_, loginSeen := e.logins[url]
	if !loginSeen {
		e.logins[url] = struct{}{}
	}
	_, qrSeen := e.qrs[url]
	emitQR := e.qr && !qrSeen
	if emitQR {
		e.qrs[url] = struct{}{}
	}
	e.mu.Unlock()

	if !loginSeen {
		e.write(loginEvent{Event: "login", URL: url})
	}
	if emitQR {
		e.write(qrEvent{Event: "qr", URL: url, Lines: qrLines(url)})
	}
}

// qrLines renders a half-block QR without ANSI colour, so the BEAM can print
// the lines raw instead of through a line-prefixing logger.
func qrLines(url string) []string {
	var buf strings.Builder
	qrterminal.GenerateHalfBlock(url, qrterminal.L, &buf)
	rendered := strings.TrimRight(buf.String(), "\n")
	if rendered == "" {
		return []string{}
	}
	return strings.Split(rendered, "\n")
}
