# Replication

## Purpose

Handles server-to-server multi-master replication. Each peer has a dedicated Manager process that catches up on missed Actions via paginated HTTP, then switches to a live SSE stream for real-time replication. Incoming replicated Actions are deduplicated (via `cf_action_dedup`), stripped of the peer's GSN, and submitted to the local Writer with trust-and-apply semantics (skip permission validation).

## Responsibilities

- Maintain a Peer Manager process per configured peer server
- Catch-up: paginated `GET /sync/replication?offset=<gsn>&limit=1000` until caught up
- Live: SSE stream `GET /sync/replication?offset=<gsn>&live=sse` for real-time replication
- Deduplicate incoming Actions against `cf_action_dedup` (by Action ID)
- Strip peer's GSN, preserve original HLC
- Submit new Actions to the local Writer with trust-and-apply (skip permission checks)
- Track per-peer replication cursor (last successfully applied GSN from peer)
- Handle connection failures with exponential backoff and circuit breaker
- Expose replication lag metrics per peer

## Public Interface

### Module: `EbbServer.Replication.PeerManager`

A GenServer per configured peer. Started by the Replication Supervisor.

| Name           | Signature                                  | Description                                                                    |
| -------------- | ------------------------------------------ | ------------------------------------------------------------------------------ |
| `start_link/1` | `start_link(opts) :: GenServer.on_start()` | `opts`: `[peer_url: String.t(), peer_id: String.t()]`                          |
| `status/1`     | `status(pid) :: peer_status()`             | Returns current replication status (catching_up, live, disconnected, backoff). |
| `lag/1`        | `lag(pid) :: non_neg_integer()`            | Returns the GSN lag (peer's max GSN - our last applied GSN from this peer).    |

### Inbound Endpoint (served by HTTP API)

| Method | Path                | Query                    | Response                                            | Description                  |
| ------ | ------------------- | ------------------------ | --------------------------------------------------- | ---------------------------- |
| `GET`  | `/sync/replication` | `offset=<gsn>&limit=<n>` | JSON array of Actions + `Stream-Next-Offset` header | Paginated catch-up for peers |
| `GET`  | `/sync/replication` | `offset=<gsn>&live=sse`  | SSE stream of Actions                               | Live replication stream      |

These endpoints are served by the HTTP API component but documented here for completeness. They use peer authentication (shared secret or mTLS), not the developer's auth URL.

### Types

```elixir
@type peer_status :: :catching_up | :live | :disconnected | :backoff

@type peer_config :: %{
  peer_id: String.t(),
  peer_url: String.t(),
  auth_token: String.t()       # Shared secret for peer auth
}
```

## Dependencies

| Dependency    | What it needs                                                                  | Reference                                            |
| ------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------- |
| RocksDB Store | `get/3` on `cf_action_dedup` for dedup check (uses default name)               | [rocksdb-store.md](rocksdb-store.md#read-operations) |
| Writer        | `WriterRouter.route_write/1` with `trust: true` flag to skip permission checks | [writer.md](writer.md#write-api)                     |

Note: The Writer's `write_actions/2` interface needs to support a `trust: true` option for replicated Actions. This bypasses the Permission Checker. The Writer still assigns local GSNs, encodes to ETF, and commits to RocksDB.

## Internal Design Notes

**Peer Manager state machine:**

```
                    ┌──────────┐
         start ───→ │ catch_up │
                    └────┬─────┘
                         │ caught up (< limit results)
                         ▼
                    ┌──────────┐
                    │   live   │ ←── SSE stream
                    └────┬─────┘
                         │ connection lost
                         ▼
                    ┌──────────┐
                    │ backoff  │ ←── exponential backoff
                    └────┬─────┘
                         │ retry
                         ▼
                    ┌──────────┐
                    │ catch_up │ ←── resume from last cursor
                    └──────────┘
```

**Catch-up loop:**

```elixir
def catch_up(peer_url, cursor) do
  case http_get("#{peer_url}/sync/replication?offset=#{cursor}&limit=1000") do
    {:ok, %{status: 200, body: actions, headers: headers}} ->
      new_actions = dedup_and_apply(actions)
      next_offset = get_header(headers, "stream-next-offset")

      if length(actions) < 1000 do
        # Caught up -- switch to live
        {:live, next_offset}
      else
        # More data -- continue catching up
        catch_up(peer_url, next_offset)
      end

    {:error, reason} ->
      {:backoff, reason}
  end
end
```

**Dedup and apply:**

```elixir
def dedup_and_apply(actions) do
  actions
  |> Enum.reject(fn action ->
    # Check cf_action_dedup -- if this Action ID already exists, skip it
    case RocksDB.get(cf_action_dedup(), action["id"]) do
      {:ok, _} -> true   # Already have this Action
      :not_found -> false # New Action
    end
  end)
  |> Enum.map(fn action ->
    # Strip peer's GSN (local Writer will assign a new one)
    # Preserve original HLC
    Map.delete(action, "gsn")
  end)
  |> case do
    [] -> :ok
    new_actions ->
      # Submit to local Writer with trust-and-apply
      WriterRouter.route_write(new_actions, trust: true)
  end
end
```

**Live SSE stream:** After catch-up, open an SSE connection to `GET /sync/replication?offset=<cursor>&live=sse`. Parse SSE events, dedup, and apply each Action as it arrives. If the connection drops, transition to backoff state.

**Exponential backoff:** Start at 1 second, double on each failure, cap at 60 seconds. Reset to 1 second on successful connection. Circuit breaker: after 10 consecutive failures, log an alert and continue retrying at the capped interval.

**Cursor persistence:** The per-peer replication cursor (last applied GSN from that peer) should survive restarts. Options:

1. Store in SQLite (simple, durable)
2. Store in RocksDB (a dedicated column family or key in `cf_action_dedup`)
3. Derive from `cf_action_dedup` on startup (scan for the max GSN from this peer)

Option 1 is simplest. Add a `replication_cursors` table to SQLite.

## HLC Trust Model

Replicated Actions use `trust: true`, which **skips all validation including HLC checks**. This is by design — the originating server already validated the HLC against its own drift/staleness limits before accepting the Action. The implications:

- **A compromised or misconfigured peer can inject Actions with arbitrary HLC values.** Peer authentication (shared secret or mTLS) is the trust boundary. If a peer is trusted to replicate, its HLCs are trusted.
- **Clock skew between peer servers does not affect replication.** Each server validates HLCs against its own clock only for locally-received client Actions. Replicated Actions carry the originating client's HLC, which was validated by the originating server at write time.
- **HLCs are never reassigned during replication.** The originating node's HLC is the canonical causal timestamp. GSNs are reassigned (each server has its own monotonic GSN sequence), but HLCs are preserved to maintain correct LWW ordering across all nodes.

If peer trust becomes a concern (e.g., multi-tenant deployment with untrusted peers), consider adding optional HLC validation on the receiving side with a wider drift window (e.g., ±24 hours) to catch obviously malicious timestamps without rejecting Actions delayed by legitimate replication lag.

## Open Questions

- **Peer authentication:** The spec mentions "shared secret or mTLS" but doesn't specify. Start with a shared secret (bearer token in the `Authorization` header). mTLS can be added later.
- **Conflict resolution across peers:** The spec says HLCs are preserved and merge is commutative (LWW by HLC, G-Counter by max, Yjs by built-in merge). This means the same entity materialized on two peers will converge to the same state regardless of Action arrival order. Verify this property with integration tests.
- **Replication of system entities:** When a replicated Action contains system entity changes (GroupMember, Relationship), the local Writer updates the ETS caches just like for local Actions. This means permission changes propagate across peers. Verify that the timing is acceptable (permission change on peer A is visible on peer B after replication lag).
- **Cursor persistence strategy:** SQLite table vs. RocksDB key vs. derived from `cf_action_dedup`. Recommend SQLite table for simplicity. This is not on any hot path.
