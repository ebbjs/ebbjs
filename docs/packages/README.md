# ebb JS Foundation Packages

## Summary

Two packages that provide building blocks for `@ebbjs/client`:

| Package | Purpose |
|---------|---------|
| [@ebbjs/core](core.md) | Types, HLC, msgpack, validation — everything foundation |
| [@ebbjs/storage](storage.md) | Storage adapter interface + memory implementation |

## Dependencies

```
@ebbjs/storage
  └── @ebbjs/core
```

## Server Alignment

The client is designed to work with `ebb_server`:

| Server Feature | Client Support |
|----------------|----------------|
| `/sync/actions` (MessagePack) | `@ebbjs/core` msgpack encode/decode |
| `/sync/handshake` | Client uses for auth + group membership |
| `/sync/live` (SSE) | SSE subscription with cursor |
| `/sync/groups/:group_id` | Catch-up with GSN offset pagination |
| HLC validation (120s/24h bounds) | HLC generation + drift validation |
| GSN cursors | Stored as numbers in storage adapter |

## Cross-cutting concerns

### Error handling
- HLC throws on drift exceed (server bounds: 120s future, 24h past)
- MessagePack throws on malformed data
- Storage adapter interface defines error shapes via `OutboxError`

### Logging
- All packages log to console with package prefix
- HLC logs drift violations at warn level

### Testing strategy
- core: types validation tests, HLC unit tests, msgpack roundtrip tests
- storage: interface compliance tests with memory adapter

## Constraints and assumptions

1. **No offline persistence in v1** — memory storage only
2. **No retry logic** — failed outbox entries stay failed
3. **No conflict resolution** — server handles LWW with HLC + update_id tiebreaker
4. **HLC format**: 64-bit packed bigint `(logical_time << 16) | counter`
5. **MessagePack**: uses `@msgpack/msgpack`, HLC as integer in wire format
6. **Cursor format**: GSN as integer (different from HLC string)