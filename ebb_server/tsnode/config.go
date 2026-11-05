package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strings"
)

const (
	httpsAuto = "auto"
	httpsOn   = "on"
	httpsOff  = "off"

	defaultHostname = "ebb"
)

// Config is the single JSON line the BEAM writes to stdin at startup.
type Config struct {
	StateDir    string   `json:"state_dir"`
	Hostname    string   `json:"hostname"`
	AuthKey     string   `json:"auth_key"`
	ControlURL  string   `json:"control_url"`
	Tags        []string `json:"tags"`
	HTTPS       string   `json:"https"`
	BackendAddr string   `json:"backend_addr"`
	ProxySecret string   `json:"proxy_secret"`
	QR          bool     `json:"qr"`
}

func parseConfig(data []byte) (Config, error) {
	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return Config{}, fmt.Errorf("config: %w", err)
	}

	cfg.StateDir = strings.TrimSpace(cfg.StateDir)
	if cfg.StateDir == "" {
		return Config{}, errors.New("config: state_dir is required")
	}

	// tsnet falls back to the OS hostname, which in a container is a random
	// id, so an empty hostname must not reach it.
	cfg.Hostname = strings.TrimSpace(cfg.Hostname)
	if cfg.Hostname == "" {
		cfg.Hostname = defaultHostname
	}

	cfg.AuthKey = strings.TrimSpace(cfg.AuthKey)
	cfg.ControlURL = strings.TrimSpace(cfg.ControlURL)

	cfg.BackendAddr = strings.TrimSpace(cfg.BackendAddr)
	if cfg.BackendAddr == "" {
		return Config{}, errors.New("config: backend_addr is required")
	}
	if _, _, err := net.SplitHostPort(cfg.BackendAddr); err != nil {
		return Config{}, fmt.Errorf("config: backend_addr %q: %w", cfg.BackendAddr, err)
	}

	mode, err := parseHTTPSMode(cfg.HTTPS)
	if err != nil {
		return Config{}, err
	}
	cfg.HTTPS = mode

	if cfg.Tags == nil {
		cfg.Tags = []string{}
	}

	return cfg, nil
}

func parseHTTPSMode(raw string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "", httpsAuto:
		return httpsAuto, nil
	case httpsOn:
		return httpsOn, nil
	case httpsOff:
		return httpsOff, nil
	default:
		return "", fmt.Errorf("config: https must be auto, on, or off, got %q", raw)
	}
}
