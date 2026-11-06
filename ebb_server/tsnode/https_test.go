package main

import (
	"strings"
	"testing"

	"tailscale.com/ipn"
	"tailscale.com/ipn/ipnstate"
)

func syntheticStatus(magicDNS bool, certDomains []string) *ipnstate.Status {
	return &ipnstate.Status{
		BackendState:   ipn.Running.String(),
		CurrentTailnet: &ipnstate.TailnetStatus{MagicDNSEnabled: magicDNS},
		CertDomains:    certDomains,
	}
}

func TestPlanHTTPSAutoUsesTLSWhenAvailable(t *testing.T) {
	plan, err := planHTTPS(httpsAuto, syntheticStatus(true, []string{"ebb.tailnet.ts.net"}))
	if err != nil {
		t.Fatalf("planHTTPS: %v", err)
	}
	if !plan.TLS {
		t.Error("TLS = false, want true")
	}
	if plan.Warning != "" {
		t.Errorf("Warning = %q, want empty", plan.Warning)
	}
}

func TestPlanHTTPSAutoFallsBackWithWarning(t *testing.T) {
	cases := map[string]*ipnstate.Status{
		"magic dns disabled": syntheticStatus(false, []string{"ebb.tailnet.ts.net"}),
		"no cert domains":    syntheticStatus(true, nil),
		"no tailnet":         {},
	}

	for name, status := range cases {
		t.Run(name, func(t *testing.T) {
			plan, err := planHTTPS(httpsAuto, status)
			if err != nil {
				t.Fatalf("planHTTPS: %v", err)
			}
			if plan.TLS {
				t.Error("TLS = true, want false")
			}
			if plan.Warning == "" {
				t.Fatal("Warning is empty, want a fallback warning")
			}
			for _, want := range []string{"MagicDNS", "HTTPS", "admin console"} {
				if !strings.Contains(plan.Warning, want) {
					t.Errorf("Warning %q does not mention %q", plan.Warning, want)
				}
			}
		})
	}
}

func TestPlanHTTPSOnRequiresTLS(t *testing.T) {
	plan, err := planHTTPS(httpsOn, syntheticStatus(true, []string{"ebb.tailnet.ts.net"}))
	if err != nil {
		t.Fatalf("planHTTPS: %v", err)
	}
	if !plan.TLS {
		t.Error("TLS = false, want true")
	}

	if _, err := planHTTPS(httpsOn, syntheticStatus(false, nil)); err == nil {
		t.Fatal("planHTTPS(on) without MagicDNS succeeded, want error")
	}
}

func TestPlanHTTPSOffNeverUsesTLS(t *testing.T) {
	plan, err := planHTTPS(httpsOff, syntheticStatus(true, []string{"ebb.tailnet.ts.net"}))
	if err != nil {
		t.Fatalf("planHTTPS: %v", err)
	}
	if plan.TLS {
		t.Error("TLS = true, want false")
	}
	if plan.Warning != "" {
		t.Errorf("Warning = %q, want none for an explicit off", plan.Warning)
	}
}
