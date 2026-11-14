# @ebbjs/codemirror

## 1.2.0

### Patch Changes

- Updated dependencies [a682fe8]
- Updated dependencies [d2cb29e]
- Updated dependencies [0c5c5d5]
- Updated dependencies [437c80d]
  - @ebbjs/client@1.2.0

## 1.1.0

### Patch Changes

- Updated dependencies [cbac1a0]
- Updated dependencies [606ee0d]
  - @ebbjs/client@1.1.0

## 1.0.0

### Major Changes

- b113df5: Collaborative text now stores immutable run cells and additive cut cells.

  A text body is a `content` map of cells — a run is a fixed string anchored at
  `(parentRunId, offset)`, and a delete is a cut `[from, to)` over the run it
  belongs to. Runs are never split, rewritten, or extended: an insert at the end
  of a run is a new run anchored at that run's length, and an insert mid-run is a
  new run anchored at the offset, so editing one run cannot invalidate another
  replica's writes. Cuts union per run, so concurrent deletes and delete-vs-insert
  commute.

  This changes what a persisted text body means:
  - The internal encoding of a text body changed. The `content` map is
    **append-only** — a cell id, once written, is never rewritten — and the body
    now carries a `version` leaf declaring the cell format. Every write stamps
    it; a read of an unknown version fails with `DocumentVersionError`. A body
    without the leaf (an empty seeded document) is read as the current version.
  - `deleted` and tombstone cell encodings are gone. Deletes are cut cells, and
    projection hides the covered characters of the owning run, leaving text
    inserted around them visible.
  - Conflict slots collapse for text. Concurrent same-run edits are no longer
    conflicts, because runs and cuts merge without a losing action: the merged
    `content` map is the whole state. Text surfaces no conflict slots.
  - An old IndexedDB database resets at open. `@ebbjs/storage` bumps
    `EBB_SCHEMA_VERSION` to 9; a database below 9 is discarded and rebuilt empty
    rather than migrated, so a tab carrying pre-release text rows does not
    half-read the new cell format. Server-side actions are untouched — this is a
    local-store reset.

  `@ebbjs/client` and `@ebbjs/codemirror` follow the same cell format, and both
  re-export the constants a caller needs (`DOC_CONTENT_FIELD`, `DOC_VERSION_FIELD`,
  `CURRENT_TEXT_VERSION`, the cell schemas).

### Minor Changes

- da11172: Presence is a typed, ephemeral, per-entity **channel** API instead of a
  hard-coded text-cursor shape.

  Declare the channels an app broadcasts with `definePresence(...)` and pass the
  registry to `createClient({ presence })`:

  ```ts
  const presence = definePresence({
    cursor: Type.Object({
      anchorId: Type.String(),
      anchorOffset: Type.Number(),
      headId: Type.String(),
      headOffset: Type.Number(),
    }),
    camera: { schema: Type.Object({ x: Type.Number(), y: Type.Number() }), ttlMs: 5_000 },
  });
  const client = createClient({ serverUrl, actorId, presence });
  ```

  `client.presence.set(entityId, channel, value)` checks the channel name and the
  `Static<>` value type at the call site and validates with `Value.Check`; an
  undeclared channel is also an `UndeclaredPresenceChannelError` at runtime, and a
  value that fails its schema is a `PresenceValidationError`. A client built
  without a registry still has `client.presence`, with dynamic string channels and
  unvalidated `unknown` values.

  Sends coalesce per `(entityId, channel)` (a send on one entity or channel never
  drops another's pending send), POST `{entity_id, data: {channel, value}}`, and
  are never queued, retried, or written to the Outbox — a failed send is dropped
  because the next write of that channel carries newer state. An oversized body
  (over 8 KiB serialized) throws `PresencePayloadTooLargeError` synchronously at
  the call site.

  `client.presence.flush()` sends pending coalesced writes immediately (for
  callers that need the last move on the wire before `pagehide`); `close()`
  cancels them instead.

  Reads go through `client.presence.forEntity(entityId, channel)`, a
  `ReadonlyMap<actorId, PeerPresence<T>>`, and `client.presence.onUpdate(cb)`
  reports the changed `(entityId, channel)` so a listener can ignore unrelated
  high-frequency channels. Each channel has a receiver-side TTL (default 30 s;
  `ttlMs: Infinity` opts out) and a per-`(entity, channel)` entry cap (default
  100). `client.presence.clear(entityId, channel)` sends `{channel, value: null}`
  so peers drop just that channel.

  Presence still rides the live stream `subscribe()` opens, so its scope is the
  groups you subscribe to and the peer set is dropped when that stream closes.

  **Breaking:** `PresenceManager`, `presence.start()`, `presence.dispose()`,
  `presence.setLocalCursor()`, and `PresenceEntry` are removed; `PeerPresence<T>`
  replaces `PresenceEntry` and entries carry `data` instead of `cursor`.
  `@ebbjs/codemirror`'s `createPresenceExtension` reads `entry.data`, and
  `getPresence` is typed as `ReadonlyMap<string, PeerPresence<CursorPresence>>`.

### Patch Changes

- Updated dependencies [3df4a29]
- Updated dependencies [da55d18]
- Updated dependencies [da11172]
- Updated dependencies [ec52770]
- Updated dependencies [e999004]
- Updated dependencies [ce74122]
- Updated dependencies [085fab5]
- Updated dependencies [6e2df83]
- Updated dependencies [6e2df83]
- Updated dependencies [6e2df83]
- Updated dependencies [6e2df83]
- Updated dependencies [6e2df83]
- Updated dependencies [6e2df83]
- Updated dependencies [6e2df83]
- Updated dependencies [6e2df83]
- Updated dependencies [b809169]
- Updated dependencies [7108176]
- Updated dependencies [48e9b64]
- Updated dependencies [b113df5]
- Updated dependencies [b8fe081]
- Updated dependencies [e543a97]
- Updated dependencies [ad79662]
  - @ebbjs/client@1.0.0

## 0.3.0

### Patch Changes

- Updated dependencies [fa0b984]
  - @ebbjs/client@0.3.0

## 0.2.0

### Minor Changes

- a46e201: `receiveRemoteHLC` now refuses only a remote HLC more than 120s ahead of the wall clock, mirroring the server's `ActionValidator`, and validates the remote value before mutating the clock so a refused merge is a no-op. Any past HLC is accepted because it only loses the merge. This narrows the public `MAX_FUTURE_DRIFT_MS` to a bound on the remote value rather than the merged local clock, and removes `MAX_PAST_DRIFT_MS` from `@ebbjs/core`'s exports.

### Patch Changes

- Updated dependencies [a46e201]
  - @ebbjs/client@0.2.0

## 0.1.1

### Patch Changes

- d19bff2: Republish through npm trusted publishing to validate the OIDC release path.
  No functional change. `0.1.0` was bootstrapped with a granular token and is the
  only version of these packages published without provenance.
- Updated dependencies [d19bff2]
  - @ebbjs/client@0.1.1

## 0.1.0

### Minor Changes

- 2004274: First public release. All `@ebbjs/*` packages share one version and ship together; `@ebbjs/server` and `@ebbjs/www` stay private.

### Patch Changes

- Updated dependencies [2004274]
  - @ebbjs/client@0.1.0
