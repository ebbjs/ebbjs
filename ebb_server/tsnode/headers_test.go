package main

import (
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"testing"
)

type headerContract struct {
	Login            string   `json:"login"`
	Name             string   `json:"name"`
	UserID           string   `json:"user_id"`
	Secret           string   `json:"secret"`
	StrippedPrefixes []string `json:"stripped_prefixes"`
	StrippedHeaders  []string `json:"stripped_headers"`
}

func readHeaderContract(t *testing.T) headerContract {
	t.Helper()
	data, err := os.ReadFile("headers.json")
	if err != nil {
		t.Fatalf("read headers.json: %v", err)
	}
	var contract headerContract
	if err := json.Unmarshal(data, &contract); err != nil {
		t.Fatalf("parse headers.json: %v", err)
	}
	return contract
}

// `headers.json` is the cross-language contract: `EbbServer.Sync.AuthPlug`
// reads the same file in its suite, so renaming a header on either side fails a
// test instead of rejecting every proxied request in production.
func TestHeaderContractMatchesInjectedNames(t *testing.T) {
	contract := readHeaderContract(t)

	for field, matches := range map[string]bool{
		"login":   strings.EqualFold(contract.Login, headerLogin),
		"name":    strings.EqualFold(contract.Name, headerName),
		"user_id": strings.EqualFold(contract.UserID, headerUserID),
		"secret":  strings.EqualFold(contract.Secret, headerSecret),
	} {
		if !matches {
			t.Errorf("headers.json %q does not match the name the gateway injects", field)
		}
	}
}

func TestStripGatewayHeadersRemovesEveryContractName(t *testing.T) {
	contract := readHeaderContract(t)

	header := http.Header{}
	for _, name := range []string{
		contract.Login,
		contract.Name,
		contract.UserID,
		contract.Secret,
		"X-Ebb-Actor-Id",
		"Tailscale-Node-Name",
		"X-Ebb-Tailscale-Other",
		"X-Keep",
	} {
		header.Set(name, "spoofed")
	}

	stripGatewayHeaders(header)

	if len(header) != 1 || header.Get("X-Keep") != "spoofed" {
		t.Fatalf("after stripping, headers = %v, want only X-Keep", header)
	}
}

func TestStripPrefixesCoverTheContract(t *testing.T) {
	contract := readHeaderContract(t)

	for _, prefix := range contract.StrippedPrefixes {
		if !hasAnyPrefix(prefix+"anything", strippedPrefixes) {
			t.Errorf("stripped_prefixes entry %q is not stripped by the gateway", prefix)
		}
	}
	for _, name := range contract.StrippedHeaders {
		header := http.Header{}
		header.Set(name, "spoofed")
		stripGatewayHeaders(header)
		if len(header) != 0 {
			t.Errorf("stripped_headers entry %q survived stripGatewayHeaders", name)
		}
	}
}
