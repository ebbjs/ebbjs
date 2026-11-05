package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"tailscale.com/client/tailscale/apitype"
	"tailscale.com/tailcfg"
)

type recordedRequest struct {
	Host    string      `json:"host"`
	Path    string      `json:"path"`
	Headers http.Header `json:"headers"`
}

func echoBackend(t *testing.T) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(recordedRequest{
			Host:    r.Host,
			Path:    r.URL.Path,
			Headers: r.Header.Clone(),
		})
	}))
	t.Cleanup(server.Close)
	return server
}

func whoisReturning(profile *tailcfg.UserProfile) whoisFunc {
	return func(context.Context, string) (*apitype.WhoIsResponse, error) {
		return &apitype.WhoIsResponse{UserProfile: profile}, nil
	}
}

func newTestProxy(t *testing.T, backendURL string, whois whoisFunc, secret string) *httptest.Server {
	t.Helper()
	backend, err := url.Parse(backendURL)
	if err != nil {
		t.Fatalf("parse backend URL: %v", err)
	}
	server := httptest.NewServer(newProxyHandler(proxyConfig{
		Backend:     backend,
		ProxySecret: secret,
		WhoIs:       whois,
		Logf:        t.Logf,
	}))
	t.Cleanup(server.Close)
	return server
}

func getThroughProxy(t *testing.T, proxyURL, path string, mutate func(*http.Request)) *http.Response {
	t.Helper()
	request, err := http.NewRequest(http.MethodGet, proxyURL+path, nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	if mutate != nil {
		mutate(request)
	}
	response, err := (&http.Client{Timeout: 10 * time.Second}).Do(request)
	if err != nil {
		t.Fatalf("proxy request: %v", err)
	}
	t.Cleanup(func() { _ = response.Body.Close() })
	return response
}

func TestProxyInjectsIdentityAndStripsSpoofedHeaders(t *testing.T) {
	backend := echoBackend(t)
	proxy := newTestProxy(t, backend.URL, whoisReturning(&tailcfg.UserProfile{
		ID:          42,
		LoginName:   "alice@example.com",
		DisplayName: "Alice",
	}), "s3cret")

	response := getThroughProxy(t, proxy.URL, "/sync/identity", func(r *http.Request) {
		r.Host = "ebb.tailnet.ts.net"
		r.Header.Set("Tailscale-User-Login", "mallory@example.com")
		r.Header.Set("tailscale-user-name", "Mallory")
		r.Header.Set("X-Ebb-Tailscale-Secret", "guessed")
		r.Header.Set("X-Ebb-Tailscale-User-Id", "999")
		r.Header.Set("X-Ebb-Actor-Id", "mallory")
		r.Header.Set("X-Keep", "kept")
	})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.StatusCode)
	}

	var recorded recordedRequest
	if err := json.NewDecoder(response.Body).Decode(&recorded); err != nil {
		t.Fatalf("decode backend request: %v", err)
	}

	if recorded.Path != "/sync/identity" {
		t.Errorf("path = %q, want /sync/identity", recorded.Path)
	}
	if recorded.Host != "ebb.tailnet.ts.net" {
		t.Errorf("host = %q, want the inbound host", recorded.Host)
	}

	headers := recorded.Headers
	for name, want := range map[string]string{
		"Tailscale-User-Login":    "alice@example.com",
		"Tailscale-User-Name":     "Alice",
		"X-Ebb-Tailscale-User-Id": "42",
		"X-Ebb-Tailscale-Secret":  "s3cret",
		"X-Forwarded-Proto":       "http",
		"X-Forwarded-Host":        "ebb.tailnet.ts.net",
		"X-Keep":                  "kept",
	} {
		if got := headers.Get(name); got != want {
			t.Errorf("%s = %q, want %q", name, got, want)
		}
		if values := headers.Values(name); len(values) > 1 {
			t.Errorf("%s sent %d values (%v), want one", name, len(values), values)
		}
	}

	if got := headers.Get("X-Ebb-Actor-Id"); got != "" {
		t.Errorf("X-Ebb-Actor-Id = %q, want it stripped", got)
	}
	if got := headers.Get("X-Forwarded-For"); got == "" {
		t.Error("X-Forwarded-For is empty, want the client address")
	}
}

func TestProxyOmitsAbsentDisplayNameAndUserID(t *testing.T) {
	backend := echoBackend(t)
	proxy := newTestProxy(t, backend.URL, whoisReturning(&tailcfg.UserProfile{
		LoginName: "bob@example.com",
	}), "")

	response := getThroughProxy(t, proxy.URL, "/sync", nil)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.StatusCode)
	}

	var recorded recordedRequest
	if err := json.NewDecoder(response.Body).Decode(&recorded); err != nil {
		t.Fatalf("decode backend request: %v", err)
	}

	if got := recorded.Headers.Get("Tailscale-User-Login"); got != "bob@example.com" {
		t.Errorf("Tailscale-User-Login = %q", got)
	}
	if _, present := recorded.Headers["Tailscale-User-Name"]; present {
		t.Error("Tailscale-User-Name present, want omitted for an empty display name")
	}
	if _, present := recorded.Headers["X-Ebb-Tailscale-User-Id"]; present {
		t.Error("X-Ebb-Tailscale-User-Id present, want omitted for a zero user id")
	}
	if _, present := recorded.Headers["X-Ebb-Tailscale-Secret"]; present {
		t.Error("X-Ebb-Tailscale-Secret present, want omitted for an unset secret")
	}
}

func TestProxyForbidsPeersWithoutUserIdentity(t *testing.T) {
	cases := map[string]whoisFunc{
		"whois error": func(context.Context, string) (*apitype.WhoIsResponse, error) {
			return nil, errors.New("peer not found")
		},
		"nil response": func(context.Context, string) (*apitype.WhoIsResponse, error) {
			return nil, nil
		},
		"tagged peer": func(context.Context, string) (*apitype.WhoIsResponse, error) {
			return &apitype.WhoIsResponse{Node: &tailcfg.Node{}}, nil
		},
		"empty login": whoisReturning(&tailcfg.UserProfile{DisplayName: "Tagged"}),
	}

	for name, whois := range cases {
		t.Run(name, func(t *testing.T) {
			proxy := newTestProxy(t, echoBackend(t).URL, whois, "s3cret")

			response := getThroughProxy(t, proxy.URL, "/sync", nil)
			if response.StatusCode != http.StatusForbidden {
				t.Fatalf("status = %d, want 403", response.StatusCode)
			}
		})
	}
}

func TestProxyReturnsBadGatewayWhenBackendIsUnreachable(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	unreachable := "http://" + listener.Addr().String()
	_ = listener.Close()

	proxy := newTestProxy(t, unreachable, whoisReturning(&tailcfg.UserProfile{
		LoginName: "alice@example.com",
	}), "s3cret")

	response := getThroughProxy(t, proxy.URL, "/sync", nil)
	if response.StatusCode != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", response.StatusCode)
	}
}

func TestProxyStreamsSSEIncrementally(t *testing.T) {
	var releaseOnce sync.Once
	release := make(chan struct{})
	releaseChunks := func() { releaseOnce.Do(func() { close(release) }) }

	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		flusher, ok := w.(http.Flusher)
		if !ok {
			t.Error("backend response writer cannot flush")
			return
		}
		fmt.Fprint(w, "data: chunk-a\n\n")
		flusher.Flush()
		<-release
		fmt.Fprint(w, "data: chunk-b\n\n")
		flusher.Flush()
	}))
	t.Cleanup(backend.Close)
	t.Cleanup(releaseChunks)

	proxy := newTestProxy(t, backend.URL, whoisReturning(&tailcfg.UserProfile{
		LoginName: "alice@example.com",
	}), "s3cret")

	response, err := (&http.Client{Timeout: 15 * time.Second}).Get(proxy.URL + "/sync")
	if err != nil {
		t.Fatalf("proxy request: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.StatusCode)
	}

	reader := bufio.NewReader(response.Body)
	firstChunk := make(chan string, 1)
	go func() {
		line, _ := reader.ReadString('\n')
		firstChunk <- line
	}()

	select {
	case line := <-firstChunk:
		if !strings.Contains(line, "chunk-a") {
			t.Fatalf("first line = %q, want chunk-a", line)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("chunk-a did not arrive before the backend wrote chunk-b")
	}

	releaseChunks()

	rest, err := io.ReadAll(reader)
	if err != nil {
		t.Fatalf("read remainder: %v", err)
	}
	if !strings.Contains(string(rest), "chunk-b") {
		t.Fatalf("remainder = %q, want chunk-b", rest)
	}
}
