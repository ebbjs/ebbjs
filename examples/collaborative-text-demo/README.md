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

To open the demo from a second machine on your tailnet, expose the local vite server with `tailscale serve`. Tailscale terminates TLS using your node's magicDNS cert and serves the traffic as HTTP/2, so the browser multiplexes over one connection instead of hitting Chromium's per-origin HTTP/1.1 socket cap (which the SSE long-polls + bootstrap POSTs can exhaust — see [issue #105](https://github.com/ebbjs/ebbjs/issues/105)).

```bash
# On the node running bandit + vite, after `pnpm dev` is up:
tailscale serve --https=8443 http://localhost:5173
```

Tailscale prints the URL to use — something like `https://<your-node>.<your-tailnet>.ts.net:8443`. Open that on another machine, appending `?actor=drew` or `?actor=alice` to each tab.

### Running with Caddy

For setups that don't use Tailscale (local dev on your own machine, or a deployment over a different network), the repo root ships a `Caddyfile` that fronts vite with HTTP/2 + TLS. The default config listens on `:8443` with `tls internal` so it works out of the box — the browser shows a one-time warning the first time you visit. Switch to an explicit Tailscale-issued cert (or any other cert) by editing the `tls` line; details are in the comments at the top of the file.

```bash
# Install Caddy: see https://caddyserver.com/docs/install for your distro.
# On Debian/Ubuntu:
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/deb.debian.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install caddy

# Three terminals (or use a process manager like tmux/foreman):
cd ebb_server && mix dev       # bandit on :4000
pnpm dev                         # vite on :5173 via root pnpm dev
caddy run --config Caddyfile     # Caddy on :8443, TLS terminates here
```

Open `https://localhost:8443/?actor=drew` and `?actor=alice` in two tabs (different machines if you're testing across the network).

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
