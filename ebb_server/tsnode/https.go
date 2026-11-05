package main

import (
	"errors"

	"tailscale.com/ipn/ipnstate"
)

var errHTTPSUnavailable = errors.New(
	"https is required but this tailnet does not serve MagicDNS and HTTPS certificates; " +
		"enable MagicDNS and HTTPS in the Tailscale admin console (DNS page) to proceed",
)

const httpsFallbackWarning = "ebb_tsnode: MagicDNS or HTTPS is not enabled for this tailnet, " +
	"serving plain http on :80; enable MagicDNS and HTTPS in the Tailscale admin console " +
	"(DNS page) to serve https"

// listenerPlan is the HTTPS decision for a node that is already running.
type listenerPlan struct {
	TLS     bool
	Warning string
}

// planHTTPS decides between TLS on :443 (with an :80 redirect) and plain :80.
// `on` fails instead of degrading; `auto` degrades but says which admin-console
// toggle is missing.
func planHTTPS(mode string, status *ipnstate.Status) (listenerPlan, error) {
	available := tlsAvailable(status)

	switch mode {
	case httpsOff:
		return listenerPlan{}, nil
	case httpsOn:
		if !available {
			return listenerPlan{}, errHTTPSUnavailable
		}
		return listenerPlan{TLS: true}, nil
	default:
		if available {
			return listenerPlan{TLS: true}, nil
		}
		return listenerPlan{Warning: httpsFallbackWarning}, nil
	}
}

func tlsAvailable(status *ipnstate.Status) bool {
	return status != nil &&
		status.CurrentTailnet != nil &&
		status.CurrentTailnet.MagicDNSEnabled &&
		len(status.CertDomains) > 0
}
