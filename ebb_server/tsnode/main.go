package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"syscall"
)

const (
	// exitRetry is a failure the supervisor should retry: the control plane is
	// unreachable, or a listener died after it was bound.
	exitRetry = 1

	// exitFatal is a failure the next attempt cannot fix. `EbbServer.Tailscale.Node`
	// stops the child on this status instead of restarting it, so a bad
	// configuration is one error line rather than a permanent restart loop.
	//
	// Not 2: the Go runtime exits 2 on an unrecovered panic, and a crash must
	// stay retryable. `contract.json` pins this value for the BEAM.
	exitFatal = 78
)

// fatalError marks a failure no restart can fix: the configuration is wrong, or
// the listener the node needs cannot be bound.
type fatalError struct{ err error }

func (e *fatalError) Error() string { return e.err.Error() }

func (e *fatalError) Unwrap() error { return e.err }

func fatal(err error) error {
	if err == nil {
		return nil
	}
	return &fatalError{err: err}
}

func isFatal(err error) bool {
	var target *fatalError
	return errors.As(err, &target)
}

func exitStatusFor(err error) int {
	if isFatal(err) {
		return exitFatal
	}
	return exitRetry
}

func main() {
	os.Exit(runMain(os.Stdin, os.Stdout, os.Stderr))
}

func runMain(stdin io.Reader, stdout, stderr io.Writer) int {
	logf := func(format string, args ...any) {
		fmt.Fprintf(stderr, format+"\n", args...)
	}

	cfg, rest, err := readConfig(stdin)
	if err != nil {
		logf("ebb_tsnode: %v", err)
		newEmitter(stdout, false).write(errorEvent{Event: "error", Message: err.Error()})
		return exitFatal
	}

	out := newEmitter(stdout, cfg.QR)
	logf("ebb_tsnode: starting hostname=%s backend=%s https=%s", cfg.Hostname, cfg.BackendAddr, cfg.HTTPS)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	signals, stopSignals := signal.NotifyContext(ctx, syscall.SIGTERM, os.Interrupt)
	defer stopSignals()

	// The BEAM holds stdin open for the process lifetime and closes it to ask
	// for shutdown, so EOF is a clean exit rather than a config error.
	go func() {
		_, _ = io.Copy(io.Discard, rest)
		cancel()
	}()

	if err := run(signals, cfg, out, logf); err != nil {
		out.write(errorEvent{Event: "error", Message: err.Error()})
		logf("ebb_tsnode: %v", err)
		return exitStatusFor(err)
	}
	return 0
}

// readConfig consumes the single startup line and returns the reader for the
// rest of stdin, whose EOF the caller treats as a shutdown request.
func readConfig(r io.Reader) (Config, io.Reader, error) {
	buffered := bufio.NewReader(r)
	line, err := buffered.ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return Config{}, nil, fmt.Errorf("read config: %w", err)
	}
	if strings.TrimSpace(line) == "" {
		return Config{}, nil, errors.New("read config: expected one JSON line on stdin")
	}

	cfg, err := parseConfig([]byte(line))
	if err != nil {
		return Config{}, nil, err
	}
	return cfg, buffered, nil
}
