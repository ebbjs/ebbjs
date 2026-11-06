package main

import (
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"testing"
)

// `contract.json` is the cross-language contract: `EbbServer.Tailscale.Node`
// and `EbbServer.Sync.AuthPlug` read the same file in their suite. It pins the
// header names, the names the gateway strips, and the exit status that means
// "do not restart", so a one-sided change fails a test instead of 401ing every
// request or silently turning a fatal error into a restart loop.
type gatewayContract struct {
	FatalExitStatus int `json:"fatal_exit_status"`
	Headers         struct {
		Login            string   `json:"login"`
		Name             string   `json:"name"`
		UserID           string   `json:"user_id"`
		Secret           string   `json:"secret"`
		StrippedPrefixes []string `json:"stripped_prefixes"`
		StrippedHeaders  []string `json:"stripped_headers"`
	} `json:"headers"`
}

func readGatewayContract(t *testing.T) gatewayContract {
	t.Helper()
	data, err := os.ReadFile("contract.json")
	if err != nil {
		t.Fatalf("read contract.json: %v", err)
	}
	var contract gatewayContract
	if err := json.Unmarshal(data, &contract); err != nil {
		t.Fatalf("parse contract.json: %v", err)
	}
	return contract
}

func TestHeaderContractMatchesInjectedNames(t *testing.T) {
	contract := readGatewayContract(t)

	for field, matches := range map[string]bool{
		"login":   strings.EqualFold(contract.Headers.Login, headerLogin),
		"name":    strings.EqualFold(contract.Headers.Name, headerName),
		"user_id": strings.EqualFold(contract.Headers.UserID, headerUserID),
		"secret":  strings.EqualFold(contract.Headers.Secret, headerSecret),
	} {
		if !matches {
			t.Errorf("contract.json %q does not match the name the gateway injects", field)
		}
	}
}

func TestStripGatewayHeadersRemovesEveryContractName(t *testing.T) {
	contract := readGatewayContract(t)

	names := []string{
		contract.Headers.Login,
		contract.Headers.Name,
		contract.Headers.UserID,
		contract.Headers.Secret,
		"X-Ebb-Actor-Id",
		"Tailscale-Node-Name",
		"X-Ebb-Tailscale-Other",
	}
	names = append(names, contract.Headers.StrippedHeaders...)

	header := http.Header{}
	for _, name := range names {
		header.Set(name, "spoofed")
	}
	header.Set("X-Keep", "spoofed")

	stripGatewayHeaders(header)

	if len(header) != 1 || header.Get("X-Keep") != "spoofed" {
		t.Fatalf("after stripping, headers = %v, want only X-Keep", header)
	}
}

func TestStripPrefixesCoverTheContract(t *testing.T) {
	contract := readGatewayContract(t)

	for _, prefix := range contract.Headers.StrippedPrefixes {
		if !hasAnyPrefix(prefix+"anything", strippedPrefixes) {
			t.Errorf("stripped_prefixes entry %q is not stripped by the gateway", prefix)
		}
	}
}

func TestFatalExitStatusMatchesContract(t *testing.T) {
	contract := readGatewayContract(t)

	if contract.FatalExitStatus != exitFatal {
		t.Fatalf("contract.json fatal_exit_status = %d, gateway exits %d",
			contract.FatalExitStatus, exitFatal)
	}

	// The Go runtime exits 2 on an unrecovered panic, and a crash must be
	// retried, not treated as a bad configuration.
	if exitFatal == 2 {
		t.Fatal("fatal exit status is 2, which is the status of an unrecovered panic")
	}
}
