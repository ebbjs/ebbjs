package main

// The BEAM reads these names in `EbbServer.Sync.AuthPlug`. `headers.json` is
// the checked-in contract both suites assert against, so a rename on one side
// fails a test instead of rejecting every proxied request in production.
const (
	headerLogin  = "Tailscale-User-Login"
	headerName   = "Tailscale-User-Name"
	headerUserID = "X-Ebb-Tailscale-User-Id"
	headerSecret = "X-Ebb-Tailscale-Secret"
)

// A peer may not set these: only the identity this gateway resolved reaches the
// BEAM. Prefixes are compared lowercased because Go canonicalizes the names it
// receives but not the ones it compares.
var (
	strippedPrefixes = []string{"tailscale-", "x-ebb-tailscale-"}
	strippedHeaders  = []string{"x-ebb-actor-id"}
)
