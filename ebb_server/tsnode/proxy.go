package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"

	"tailscale.com/client/tailscale/apitype"
	"tailscale.com/tailcfg"
)

// whoisFunc resolves the tailnet peer behind remoteAddr. Production wraps
// LocalClient().WhoIs; tests inject a fake so the proxy needs no tailnet.
type whoisFunc func(ctx context.Context, remoteAddr string) (*apitype.WhoIsResponse, error)

var errNoUserIdentity = errors.New("peer has no tailnet user identity")

type proxyConfig struct {
	Backend     *url.URL
	ProxySecret string
	WhoIs       whoisFunc
	Logf        func(format string, args ...any)
}

func newProxyHandler(cfg proxyConfig) http.Handler {
	reverseProxy := httputil.NewSingleHostReverseProxy(cfg.Backend)
	// SSE must reach the browser on each upstream write, not on a buffer flush.
	reverseProxy.FlushInterval = -1
	reverseProxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		cfg.logf("proxy %s %s: %v", r.Method, r.URL.Path, err)
		http.Error(w, "bad gateway", http.StatusBadGateway)
	}

	upstreamDirector := reverseProxy.Director
	reverseProxy.Director = func(out *http.Request) {
		host := out.Host
		upstreamDirector(out)
		// The BEAM binds on loopback, so the tailnet host it was addressed by
		// must survive the rewrite to the backend address.
		out.Host = host
		out.Header.Set("X-Forwarded-Host", host)
		out.Header.Set("X-Forwarded-Proto", forwardedProto(out))
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		stripGatewayHeaders(r.Header)

		profile, err := resolveIdentity(r.Context(), cfg.WhoIs, r.RemoteAddr)
		if err != nil {
			cfg.logf("proxy %s: %v", r.RemoteAddr, err)
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}

		injectIdentity(r.Header, profile, cfg.ProxySecret)
		reverseProxy.ServeHTTP(w, r)
	})
}

func (cfg proxyConfig) logf(format string, args ...any) {
	if cfg.Logf != nil {
		cfg.Logf(format, args...)
	}
}

// resolveIdentity rejects a peer the gateway cannot name. A tagged client has
// no UserProfile, and an empty login is not an actor.
func resolveIdentity(ctx context.Context, whois whoisFunc, remoteAddr string) (*tailcfg.UserProfile, error) {
	response, err := whois(ctx, remoteAddr)
	if err != nil {
		return nil, err
	}
	if response == nil || response.UserProfile == nil {
		return nil, errNoUserIdentity
	}
	if response.UserProfile.LoginName == "" {
		return nil, errNoUserIdentity
	}
	return response.UserProfile, nil
}

// stripGatewayHeaders removes copies the peer sent, so only the identity this
// gateway resolved reaches the BEAM. A bare X-Ebb-Actor-Id must not pass
// either: tailscale mode never falls back to it.
func stripGatewayHeaders(header http.Header) {
	for name := range header {
		lower := strings.ToLower(name)
		if strings.HasPrefix(lower, "tailscale-") ||
			strings.HasPrefix(lower, "x-ebb-tailscale-") ||
			lower == "x-ebb-actor-id" {
			delete(header, name)
		}
	}
}

func injectIdentity(header http.Header, profile *tailcfg.UserProfile, secret string) {
	header.Set("Tailscale-User-Login", profile.LoginName)
	if profile.DisplayName != "" {
		header.Set("Tailscale-User-Name", profile.DisplayName)
	}
	if profile.ID != 0 {
		header.Set("X-Ebb-Tailscale-User-Id", strconv.FormatInt(int64(profile.ID), 10))
	}
	if secret != "" {
		header.Set("X-Ebb-Tailscale-Secret", secret)
	}
}

func forwardedProto(r *http.Request) string {
	if r.TLS != nil {
		return "https"
	}
	return "http"
}
