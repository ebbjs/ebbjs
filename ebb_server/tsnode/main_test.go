package main

import (
	"bytes"
	"errors"
	"strings"
	"testing"
)

func TestRunMainReportsUnusableConfigAsFatal(t *testing.T) {
	cases := map[string]string{
		"empty stdin":        "",
		"not json":           "not json\n",
		"missing backend":    `{"state_dir":"/tmp/ebb"}` + "\n",
		"unknown https mode": `{"state_dir":"/tmp/ebb","backend_addr":"127.0.0.1:4000","https":"maybe"}` + "\n",
	}

	for name, stdin := range cases {
		t.Run(name, func(t *testing.T) {
			var stdout, stderr bytes.Buffer

			if got := runMain(strings.NewReader(stdin), &stdout, &stderr); got != exitFatal {
				t.Fatalf("exit status = %d, want %d", got, exitFatal)
			}
			if !strings.Contains(stdout.String(), `"event":"error"`) {
				t.Errorf("stdout = %q, want an error event", stdout.String())
			}
			if stderr.Len() == 0 {
				t.Error("stderr is empty, want the reason for the exit")
			}
		})
	}
}

// A fatal failure has to stay distinguishable from a retryable one through the
// wrapping that names what failed.
func TestFatalErrorsKeepTheirCause(t *testing.T) {
	cause := errors.New("https is required")
	wrapped := fatal(errors.Join(errors.New("listen tls"), cause))

	if !isFatal(wrapped) {
		t.Fatal("wrapped fatal error is not reported as fatal")
	}
	if !errors.Is(wrapped, cause) {
		t.Error("wrapped fatal error lost its cause")
	}
	if exitStatusFor(wrapped) != exitFatal {
		t.Errorf("exit status = %d, want %d", exitStatusFor(wrapped), exitFatal)
	}
	if isFatal(errors.New("connect")) || exitStatusFor(errors.New("connect")) != exitRetry {
		t.Error("an ordinary error is treated as fatal")
	}
	if got := exitStatusFor(fatal(nil)); got != exitRetry {
		t.Errorf("fatal(nil) exit status = %d, want the retry status", got)
	}
}
