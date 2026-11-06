package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"tailscale.com/ipn"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tsnet"
)

const (
	statusPollInterval = time.Second
	readHeaderTimeout  = 10 * time.Second
	// Below the BEAM's 5s drain deadline (see `EbbServer.Tailscale.Node`), so a
	// gateway that is draining by itself finishes before the node escalates.
	shutdownTimeout = 3 * time.Second

	// Idle applies between requests on a kept-alive connection, never to a
	// response in flight, so a long SSE stream is not cut by it.
	idleTimeout = 2 * time.Minute

	// A node that cannot reach control has no auth URL and never reaches
	// Running; one diagnosable line beats tsnet's per-retry debug output.
	controlWarningGrace    = 5 * time.Second
	controlWarningInterval = 60 * time.Second

	listenAddrHTTP  = ":80"
	listenAddrHTTPS = ":443"
)

func newTailscaleServer(cfg Config, logf func(format string, args ...any)) *tsnet.Server {
	return &tsnet.Server{
		Dir:           cfg.StateDir,
		Hostname:      cfg.Hostname,
		AuthKey:       cfg.AuthKey,
		ControlURL:    cfg.ControlURL,
		AdvertiseTags: cfg.Tags,
		// UserLogf carries the interactive auth URL; Logf is tsnet's verbose
		// backend debug and would drown the BEAM log in control retries.
		UserLogf: logf,
	}
}

// run owns the node for the process lifetime: it publishes auth URLs, starts
// the listeners once the node is running, and keeps watching status so a node
// removed from the tailnet prints a fresh login URL.
func run(ctx context.Context, cfg Config, out *emitter, logf func(format string, args ...any)) error {
	server := newTailscaleServer(cfg, logf)
	if err := server.Start(); err != nil {
		// A start failure is local setup: an unusable state directory, a lock
		// held by another process, or the log-policy requirement tsnet refuses
		// to run without. Restarting repeats it.
		return fatal(fmt.Errorf("start tsnet: %w", err))
	}

	client, err := server.LocalClient()
	if err != nil {
		server.Close()
		return fmt.Errorf("tsnet local client: %w", err)
	}

	backend, err := url.Parse("http://" + cfg.BackendAddr)
	if err != nil {
		server.Close()
		return fatal(fmt.Errorf("backend address: %w", err))
	}

	servers := &httpServers{logf: logf, errs: make(chan error, 1)}
	defer func() {
		servers.shutdown()
		server.Close()
	}()

	handler := newProxyHandler(proxyConfig{
		Backend:     backend,
		ProxySecret: cfg.ProxySecret,
		WhoIs:       client.WhoIs,
		Logf:        logf,
	})

	// Up blocks until the node is authorized; a terminal backend error is only
	// visible here, so the status poll alone is not enough.
	connectErr := make(chan error, 1)
	go func() {
		_, err := server.Up(ctx)
		connectErr <- err
	}()

	started := false
	startedAt := time.Now()
	lastState := ""
	var lastWarn time.Time
	poll := time.NewTimer(0)
	defer poll.Stop()

	for {
		select {
		case <-ctx.Done():
			return nil

		case err := <-connectErr:
			connectErr = nil
			if err != nil && ctx.Err() == nil && !errors.Is(err, context.Canceled) {
				// `Up` only returns once the backend gives up: a rejected or
				// expired auth key, a control server that refuses the node, or a
				// tailnet policy that forbids it. None of those fix themselves.
				return fatal(fmt.Errorf("connect: %w", err))
			}

		case err := <-servers.errs:
			return err

		case <-poll.C:
			poll.Reset(statusPollInterval)

			status, err := client.StatusWithoutPeers(ctx)
			if err != nil {
				if ctx.Err() != nil {
					return nil
				}
				logf("ebb_tsnode: status: %v", err)
				continue
			}

			out.notifyAuthURL(status.AuthURL)

			if !started {
				if msg, warn := controlWarning(status, startedAt, lastState, lastWarn, time.Now()); warn {
					logf("%s", msg)
					lastState = status.BackendState
					lastWarn = time.Now()
				}
			}

			if started || status.BackendState != ipn.Running.String() {
				continue
			}
			if err := servers.serve(server, cfg, status, handler, out); err != nil {
				return err
			}
			started = true
		}
	}
}

type httpServers struct {
	logf    func(format string, args ...any)
	servers []*http.Server
	// A listener that stops serving usually means the node needs to reconnect,
	// so `run` takes the error and a fresh gateway tries again.
	errs chan error
}

// serve binds the tailnet listeners and only then publishes `running`, so the
// BEAM never advertises a URL that cannot accept a connection.
func (h *httpServers) serve(
	server *tsnet.Server,
	cfg Config,
	status *ipnstate.Status,
	handler http.Handler,
	out *emitter,
) error {
	// HTTPS availability and the status shape are read from a netmap that can
	// still be catching up (an admin-console toggle propagates through it), so
	// both stay retryable rather than stopping the gateway for good.
	plan, err := planHTTPS(cfg.HTTPS, status)
	if err != nil {
		return err
	}
	running, err := runningEventFor(status, plan.TLS)
	if err != nil {
		return err
	}
	if plan.Warning != "" {
		h.logf("%s", plan.Warning)
	}

	if plan.TLS {
		tlsListener, err := server.ListenTLS("tcp", listenAddrHTTPS)
		if err != nil {
			return fmt.Errorf("listen tls: %w", err)
		}
		h.start(tlsListener, handler)

		redirectListener, err := server.Listen("tcp", listenAddrHTTP)
		if err != nil {
			return fmt.Errorf("listen redirect: %w", err)
		}
		h.start(redirectListener, redirectHandler(running.URL))
	} else {
		listener, err := server.Listen("tcp", listenAddrHTTP)
		if err != nil {
			return fmt.Errorf("listen: %w", err)
		}
		h.start(listener, handler)
	}

	out.write(running)
	return nil
}

func (h *httpServers) start(listener net.Listener, handler http.Handler) {
	httpServer := &http.Server{
		Handler: handler,
		// No WriteTimeout: an SSE stream stays open for the life of a session.
		ReadHeaderTimeout: readHeaderTimeout,
		IdleTimeout:       idleTimeout,
	}
	h.servers = append(h.servers, httpServer)

	go func() {
		if err := httpServer.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			h.logf("ebb_tsnode: serve: %v", err)
			select {
			case h.errs <- fmt.Errorf("serve: %w", err):
			default:
			}
		}
	}()
}

func (h *httpServers) shutdown() {
	ctx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()

	for _, httpServer := range h.servers {
		_ = httpServer.Shutdown(ctx)
	}
}

// redirectHandler moves plain-HTTP tailnet requests to the TLS listener. 308
// keeps the method and body so a write is not silently downgraded.
func redirectHandler(baseURL string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, baseURL+r.URL.RequestURI(), http.StatusPermanentRedirect)
	})
}

func runningEventFor(status *ipnstate.Status, tls bool) (runningEvent, error) {
	if status.Self == nil {
		return runningEvent{}, errors.New("tailscale status has no self node")
	}

	dnsName := strings.TrimSuffix(status.Self.DNSName, ".")
	ips := make([]string, 0, len(status.TailscaleIPs))
	for _, ip := range status.TailscaleIPs {
		ips = append(ips, ip.String())
	}

	host := dnsName
	if host == "" && len(ips) > 0 {
		host = ips[0]
	}
	if host == "" {
		return runningEvent{}, errors.New("tailscale status has no DNS name or tailnet IP")
	}

	tags := []string{}
	if status.Self.Tags != nil {
		// The status view may be an empty slice, but a nil list would
		// serialize as JSON null instead of the empty applied-tags list.
		tags = append(tags, status.Self.Tags.AsSlice()...)
	}

	event := runningEvent{
		Event:   "running",
		URL:     scheme(tls) + "://" + host,
		DNSName: dnsName,
		IPs:     ips,
		TLS:     tls,
		Tags:    tags,
	}
	if status.Self.KeyExpiry != nil {
		event.KeyExpiry = status.Self.KeyExpiry.UTC().Format(time.RFC3339)
	}
	return event, nil
}

func scheme(tls bool) string {
	if tls {
		return "https"
	}
	return "http"
}

// controlWarning names a node that is neither running nor waiting on an
// interactive login, after a grace period and then at most once a minute (or
// immediately on a state change), so a control-plane outage is visible in the
// BEAM log without forwarding every tsnet retry.
func controlWarning(
	status *ipnstate.Status,
	startedAt time.Time,
	lastState string,
	lastWarn time.Time,
	now time.Time,
) (string, bool) {
	if status == nil || status.AuthURL != "" {
		return "", false
	}
	if now.Sub(startedAt) < controlWarningGrace {
		return "", false
	}
	if status.BackendState == lastState && now.Sub(lastWarn) < controlWarningInterval {
		return "", false
	}

	return fmt.Sprintf(
		"ebb_tsnode: control server unreachable or node not authorized "+
			"(backend state: %s); retrying",
		status.BackendState,
	), true
}
