# Investigation: ebbjs#105 — resolved via Caddy + HTTP/2

> **Status:** **RESOLVED.** Root cause is browser-side HTTP/1.1 connection-pool contention (Chromium caps simultaneously-active or keep-alive sockets per origin at 6) when two tabs share one `browser.newContext()`. The demo's bootstrap in dev (with `<StrictMode>` doubling effects) opens enough sockets to push the count past the cap; subsequent burst `POST /sync/actions` requests are dispatched by the page but queued indefinitely in Chromium's pipeline because no TCP socket frees up (SSE long-polls never close).
>
> **Resolution:** Front the demo with Caddy over HTTP/2. Caddy terminates TLS at the demo's Tailscale hostname and proxies h1 to vite on `:5173`. The browser connects to Caddy over h2 (one connection per tab, all requests multiplexed as streams), and the per-origin socket cap is no longer load-bearing. Verified: 3/3 runs on fresh data through Caddy pass; 3/3 runs on fresh data directly to vite (no Caddy) fail with the original 15s timeout.

## TL;DR

- The burst's writes **never reach bandit** — the bandit log shows zero `POST /sync/actions` from the burst, only the 8 bootstrap POSTs.
- The writes **never reach vite** either — Chromium's connection pool to the demo's origin has 8 ESTAB sockets (exceeding the 6-per-origin cap), and new requests sit in the browser pipeline without ever opening a socket.
- Killing one tab's SSE long-poll drops the socket count to 4-5 and the burst goes through. That's the decisive experiment for the mechanism.
- The previous investigator's "client-side bootstrap race" theory was a guess; the connection-state machine reaches `live` cleanly in both tabs and the failure is purely in the burst path's _outbound_ HTTP, not in any client state machine.
- **The fix is transport-layer, not application-layer.** Caddy in front of vite, terminating TLS over h2, eliminates the bug with zero changes to `@ebbjs/client` or the demo's bootstrap.

## What's solid (verified)

| Configuration                                                                               | Burst result                                           |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Two pages, **shared** `browser.newContext()`, fresh `data/`, vite dev (no Caddy)            | **FAIL** — 15s timeout, p2 sees `""`                   |
| Two pages, shared context, fresh `data/`, vite dev (no Caddy), **single-X**                 | PASS — per previous investigator, 10/10                |
| Two pages, shared context, fresh `data/`, vite dev (no Caddy), **one tab only**             | PASS — single write drains all 20 actions              |
| Two pages, shared context, fresh `data/`, vite dev (no Caddy), **kill p2 SSE before burst** | PASS — p1 burst propagates; socket count drops 8 → 4-5 |
| Two pages, shared context, fresh `data/`, **Caddy h2**                                      | **PASS** — ~1s, bandit log shows 10 POSTs              |
| Two pages, **separate** `browser.newContext()`, fresh `data/`, vite dev (no Caddy)          | PASS — ~1s, p2 sees all 20 x's                         |
| Two pages, shared context, **warm** `data/`, vite dev (no Caddy)                            | PASS — per previous investigator                       |

## Mechanism

Chromium's HTTP/1.1 implementation caps simultaneously-active-or-keep-alive sockets per origin at 6 (Chromium's internal `kMaxSocketsPerGroup`; RFC 7230 §6.4 standardizes 2, Chromium uses 6). When the demo's bootstrap in a shared context establishes:

- 2 SSE long-polls (one per tab — held for the entire session)
- ~6 keep-alive sockets from the 8 bootstrap POSTs that vite keeps open with its default `keepAliveTimeout`

…Chromium's pool is at the 6-cap with all sockets in some "active or keep-alive" state. The Editor's 250ms flush timer dispatches `client.write(pending)`, the page-level `fetch()` call returns immediately (the promise has not resolved or rejected), but Chromium's HTTP stack cannot assign a socket to the new request. It sits in Chromium's internal pending-connection queue indefinitely.

The SSE long-polls never close (they're healthy), so slots never free. The writes never propagate. The local CodeMirror continues accepting keystrokes (the optimistic local apply works), `doc.pendingActions()` grows on each tick, the same batch is re-flushed, and nothing reaches bandit.

The "kill one SSE" experiment is decisive: removing one tab's SSE long-poll drops the browser→origin socket count from 8 to 4-5, and the burst goes through. This pinpoints the load-bearing constraint as the **socket count** (which the per-origin cap governs), not anything about the client or the proxy chain.

## Why earlier theories don't fit

| Theory                                       | Fits?                   | Why                                                                                                                                                  |
| -------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vite's `http-proxy` aborting in-flight SSE   | No                      | The `:already_started` / `ERR_ABORTED` events under vite dev are real but a _symptom_. Bug reproduces under a Node reverse proxy with no SSE aborts. |
| Connection-pool exhaustion upstream of vite  | No                      | `ss -tn :4000` stable at 6 across failing runs (Node's `http.Agent` max).                                                                            |
| Connection-pool exhaustion _of the browser_  | **Yes**                 | Diagnostic evidence points at Chromium's per-origin socket cap.                                                                                      |
| `client.write()`'s Promise never resolves    | Yes, downstream symptom | The Promise is the `fetch()` promise; it never settles because Chromium never assigns a socket.                                                      |
| Connection-state machine hangs before `live` | No                      | Both tabs reach `live` (assertion passes) before the burst.                                                                                          |
| Client-side bootstrap race                   | No                      | State machine is in `live`. Writes aren't getting a socket — they're queued in Chromium.                                                             |
| StrictMode-doubled bootstrap                 | Adjacent cause          | StrictMode doubles bootstrap POSTs (4 per tab → 8), pushing socket count over the cap faster. Removing `<StrictMode>` makes the failing spec pass.   |

## Why Caddy fixes it

Caddy in front of vite gives the browser HTTP/2 to the demo's origin. h2 multiplexes many requests over a single TCP connection, so Chromium uses one connection per `(tab, origin)` pair regardless of how many concurrent fetches are in flight. The 6-per-origin cap is bypassed entirely.

Socket-state evidence:

```
# Before (h1, vite :5173, bug reproduces)
[vite-conn both-live] total=8 {"ESTAB":8}
  ESTAB 0      636            [::1]:41730        [::1]:5173    ← SSE p1 (Recv-Q=636)
  ESTAB 0      0              [::1]:41710        [::1]:5173
  ESTAB 0      0              [::1]:41770        [::1]:5173
  ESTAB 0      636            [::1]:41746        [::1]:5173    ← SSE p2 (Recv-Q=636)
  ESTAB 0      0              [::1]:41722        [::1]:5173
  ESTAB 0      0              [::1]:41702        [::1]:5173
  ESTAB 0      0              [::1]:41720        [::1]:5173
  ESTAB 0      0              [::1]:41754        [::1]:5173

# After (h2, Caddy :8443 → vite, bug gone)
[h2 settled]   browser→https://localhost:5174  2 sockets {"ESTAB":2}
[h2 pre-burst] browser→https://localhost:5174  2 sockets {"ESTAB":2}
[h2 post-burst] browser→https://localhost:5174  2 sockets {"ESTAB":2}
```

8 sockets → 2 sockets. The burst propagates through Caddy because every request multiplexes over the same h2 connection.

## What I haven't pinned down

- **Cross-browser**: only `chromium-1243` is installed in this Playwright env. Firefox's HTTP/1.1 cap is the same as Chrome's, so the bug should reproduce there too; the Caddy fix should work the same way.
- **Production build (`pnpm preview`)**: not tested against Caddy. The demo's `pnpm preview` path has its own issues (CORS, no SSE-over-`pnpm preview`-without-proxy), so the recommended dev path is `pnpm dev` + Caddy.

## Artifacts (committed in this PR)

- `Caddyfile` — the fix.
- `examples/collaborative-text-demo/e2e/diag-105-caddy.spec.mjs` + `playwright.diag-caddy.config.ts` — regression test (skips unless `EBB_CADDY_URL` is set).
- `examples/collaborative-text-demo/README.md` — "Running over Tailscale" section.
- This document.

## Process hygiene

- No source code committed outside of the files listed above. `App.tsx`, `main.tsx`, and the demo's bootstrap are unchanged from HEAD.
- All spawned processes killed; ports free.
