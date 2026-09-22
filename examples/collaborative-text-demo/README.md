# Collaborative Text Demo

A Vite + React 19 + CodeMirror 6 app that opens a browser-based collaborative text editor against a running ebb sync server.

Two tabs editing the same document see each other's keystrokes in real time, with edits flowing through Actions, the Elixir sync server, and SSE fan-out — **not via `BroadcastChannel`**. Concurrent edits at the same position surface as visible conflicts in the right-hand panel.

## Run it

From the repo root, one command starts both processes in the same pane:

```bash
pnpm dev
```

Or run them separately if you want isolated logs:

```bash
# Terminal 1: server (auto-reload on lib/ save)
cd ebb_server && mix dev

# Terminal 2: demo
pnpm --filter collaborative-text-demo dev
```

Then open:

- <http://localhost:5173/?actor=drew> in one tab
- <http://localhost:5173/?actor=alice> in another

Type in one tab — the text appears in the other within ~100ms. Concurrent edits at the same position appear in the "Show conflicts" panel on both tabs.

### Running over Tailscale

For two-tab testing from a different machine on your Tailscale network, run Caddy in front of vite. The browser talks HTTP/2 to Caddy, which proxies to vite over HTTP/1.1. Without h2, burst typing in shared browser contexts can hang because Chromium's per-origin socket cap (6) is exceeded by the SSE long-polls + bootstrap POSTs — see [issue #105](../../docs/investigations/issue-105-shared-ctx-burst.md) for the full diagnosis.

Caddy listens on `:8443` (`:443` is typically occupied by another service on the same host — e.g., Dokploy in our setup). Change the `:8443` in `Caddyfile` if you want a different port.

```bash
# One-time setup (on the Tailscale node running bandit + vite):
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/deb.debian.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install caddy

# Issue a Tailscale-issued Let's Encrypt cert for the node's magicDNS name.
tailscale cert <your-node>.<your-tailnet>.ts.net
# Move cert files into Caddy's expected location (Tailscale writes them
# to the current directory by default).
mkdir -p ~/.local/share/caddy/tailscale
mv <your-node>.<your-tailnet>.ts.net.crt \
   <your-node>.<your-tailnet>.ts.net.key \
   ~/.local/share/caddy/tailscale/
chmod 644 ~/.local/share/caddy/tailscale/*.crt
chmod 600 ~/.local/share/caddy/tailscale/*.key
```

Edit `Caddyfile` at the repo root to match your hostname and cert paths, then run:

```bash
# Three terminals (or use a process manager like tmux/foreman):
cd ebb_server && mix dev                                  # bandit on :4000
pnpm dev                                                    # vite on :5173 via root pnpm dev
caddy run --config Caddyfile                                # Caddy on :8443, TLS terminates here
```

Then from your other Tailscale machine, open:

- `https://<your-node>.<your-tailnet>.ts.net:8443/?actor=drew`
- `https://<your-node>.<your-tailnet>.ts.net:8443/?actor=alice`

## How it works

1. The `?actor=` URL param sets the actor id (bypass auth mode).
2. On first load the demo calls `seed()` to bootstrap a `grp_demo` group + `doc_demo` document via `POST /sync/actions`.
3. A `SyncClient` opens an SSE subscription for the demo's groups.
4. A CodeMirror 6 view is wired to a `TextDocument` via [`@ebbjs/codemirror`](../../packages/codemirror/).
5. Edits are flushed to the server every 250ms via `client.write(doc.pendingActions())`.
6. Incoming SSE data events are piped into `doc.applyActions()`, which fires `onUpdate` — the bridge reflects the change in CM.
7. Concurrent edits at the same run are recorded by the conflict detector and surfaced via `doc.onConflict()`.

## Files

```
src/
├── main.tsx           # React entry
├── App.tsx            # Top-level layout (header, editor, footer, conflict panel)
├── bootstrap.ts       # handshake + seed + subscribe
├── seed.ts            # demo data bootstrap (one group + member + empty doc)
├── Editor.tsx         # CM6 + bridge + SSE subscription + flush timer
├── ConnectionBadge.tsx # Connection state indicator
├── ConflictPanel.tsx  # Right sidebar with recorded conflicts
└── index.css          # Tailwind v4 + dark theme
```

## What this slice delivers (slice 3 of the [prototype plan](../../packages/client/docs/prototypes/collaborative-text/README.md))

- ✅ New `examples/collaborative-text-demo/` package
- ✅ Bridge from CM6 to `TextDocument` (in `@ebbjs/codemirror`)
- ✅ `?actor=drew|alice` URL param → bypass auth
- ✅ Hardcoded `grp_demo` / `doc_demo`; seeded on first load
- ✅ Connection-state indicator
- ✅ Conflict panel (collapsible)
- ⏭️ Presence (deferred to slice 5 polish — see plan)
- ⏭️ Playwright e2e test (slice 4)
