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
		return 1
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
		return 1
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
