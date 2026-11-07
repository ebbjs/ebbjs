---
title: "Entity history"
description: "Read the replica's Action log as a per-entity list of field-level changes — for change review, undo across sessions, and restore — with the retention caveats that come with it."
---

`client.history({ entityId })` answers **"what happened to this entity, in order?"** from the replica's append-only Action log. The bytes are already on the device, so a change review, an audit feed, or a restore UI costs no extra snapshotting.

> **Shipped in [#756](https://github.com/ebbjs/ebbjs/issues/756).** History is a client-side read over the local log. A server-side history endpoint and log compaction are separate designs; retention is [#123](https://github.com/ebbjs/ebbjs/issues/123).

## Reading history

```ts
const events = await client.history({ entityId: wall.id });
// newest first, one event per Action that touched the entity
```

Each event carries the Action's identity plus the field-level change it made:

```ts
interface HistoryEvent {
  readonly actionId: string;
  readonly actorId: string;
  readonly hlc: string;
  readonly gsn: number;
  readonly methods: readonly Update["method"][];
  readonly changes: readonly EntityDiff[];
}
```

`changes` uses the same field-path vocabulary as the conflict view ([Offline conflicts](/docs/conflicts)): one entry per differing position, with `field`, `path` (the map keys from the field root, empty for a whole field), `before`, `after`, and `kind` (`added` / `removed` / `changed`). The diff is the shared projection — a map-key edit is a `path` entry, not a whole-map replacement. A create has no before row, so it reports each top-level field once as `added` (a whole map is one position); `path` entries appear once both rows hold the map.

`methods` lists the entity's Update methods in the Action, each once and in first-seen order. It is what makes a delete legible: `applyUpdate` keeps a deleted row's fields, so a delete produces `methods: ["delete"]` with `changes: []`, not "every field removed". A method records what the Action attempted, so a patch the fold rejected (against a tombstoned or absent row) also appears with `changes: []`.

### Paging

```ts
const page = await client.history({ entityId: wall.id, limit: 20 });
const older = await client.history({ entityId: wall.id, beforeGsn: page.at(-1)!.gsn });
```

- `limit` defaults to `50`. It is a **slice, not a read bound**: `ActionLog.getForEntity` reads the entity's whole action list and sorts it in memory, so a very old entity costs the whole list before `limit` applies.
- `beforeGsn` returns only events with a strictly lower GSN. Because backfill Actions can carry `gsn: 0` and a re-delivered Action can repeat a GSN, a page boundary that falls inside such a tie can omit the events sharing that GSN. Keep the tied events in one page (raise `limit`) or resume from the tied events rather than from the last GSN.

Events are folded in **GSN order**, not arrival order: a backfill Action with `gsn: 0` folds first even though it was delivered later. That is the ordering `history` contracts on, the one `ActionLog.getForEntity` provides.

## Replaying a past row

```ts
const rowThen = await client.replay({
  entityId: wall.id,
  at: { actionId: events[3].actionId },
});
```

`replay` folds the log up to and **including** the named Action and returns the row the log materializes at that point. This is the primitive a restore or undo UI builds on: the row carries the fields the entity held, not a diff to reverse.

`replay` returns `null` when the Action is not in the entity's local log — for example because it was compacted away, or because the id belongs to another entity — or when the fold never produced a row there (compaction can leave a `patch` or `delete` as the oldest surviving Action, and neither materializes without a base).

## What history is not

History and the conflict view both expose before/after positions, and they are deliberately different reads:

|           | History                                        | Conflict                                                  |
| --------- | ---------------------------------------------- | --------------------------------------------------------- |
| Question  | What events happened to this entity, in order? | Which buffered local writes raced with the missed window? |
| Unit      | one event per Action/Update                    | one slot per overlapping position, plus a net diff        |
| Optimism  | absent — local Actions are logged on echo      | included in `before`                                      |
| Retention | bounded by the cursor and compaction           | durable copy on the outbox row; survives compaction       |

The conflict resolver does **not** consume history, and `Conflict.subjectStates[].before` is not a replay: it is the client's last synced row with its own unflushed writes optimistically applied.

## Retention and the cases that follow

History is a read over whatever the local log holds. It is **bounded by the client's cursor and, once it lands, by #123 compaction**. A device that syncs from cursor `0` gets the full log today, but that is not a permanent guarantee.

| Case                       | `history`                                                                                                                                              | `replay`                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Unknown entity             | `[]`                                                                                                                                                   | `null`                                                                                                  |
| Tombstoned entity          | includes the `delete` event (`methods: ["delete"]`, `changes: []`); earlier events are unchanged                                                       | at or after the delete, returns the tombstoned row (`deleted_hlc` set) with its fields retained         |
| Absent / compacted history | starts at the oldest Action the local log still holds; that event can begin with a `patch` or `delete`                                                 | `null` when the named Action is gone, and also when a leading `patch`/`delete` never materialized a row |
| Late-joining device        | listing seeds and content backfill are Actions in the log, so they appear as events; filter on `actorId` (`a_seed_listing`, `a_backfill`) to hide them | whatever the local log materializes; a fold that starts after the create has no earlier row             |

A just-saved local edit does **not** appear until its echo lands: local Actions are applied to the replica optimistically but are not appended to the log until the server returns them with a GSN. State that in an undo UI — "pending" is the outbox, not history.

## References

- [#756](https://github.com/ebbjs/ebbjs/issues/756) — the history read
- [#123](https://github.com/ebbjs/ebbjs/issues/123) — action-log retention and compaction
- [Offline conflicts](/docs/conflicts) — the before/after model history shares its diff with
- `packages/client/src/sync/history.ts`, `packages/storage/src/internal/materialize.ts` (`foldEntityAction`), `packages/write/src/entity-diff.ts`
