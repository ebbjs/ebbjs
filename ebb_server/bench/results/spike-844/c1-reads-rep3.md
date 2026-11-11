
21:29:21.778 [info] Running EbbServer.Sync.Router with Bandit 1.10.4 at 0.0.0.0:4981 (http)
### point read p50 — one Entity row, 10000 Entities

| read | samples | p50 µs | p95 µs | p99 µs |
| --- | --- | --- | --- | --- |
| EntityStore.get/3 (clean hit) | 10000 | 26.27 | 49.14 | 74.52 |
| EntityStore.get/3 (first touch) | 10000 | 430.59 | 1473.43 | 77292.55 |
| exqlite SELECT by id | 10000 | 16.43 | 26.66 | 45.76 |
| MemoryIndex.entity_state/1 | 10000 | 1.34 | 3.75 | 5.86 |

`entities` 10000, `found` dirty 10000/10000, clean 10000/10000, raw 10000/10000, entity_state 10000/10000, `state_over_clean` 0.05, `state_over_first_touch` 0.0

**host**: `recsy-vps`, 4 schedulers, build `397ad54f` (dirty working tree),
31.68 s wall, hypervisor steal **32.8 %**, longest scheduler pause **83.0 ms**.

- `exqlite SELECT by id` is bind + step + reset on one prepared statement against the booted tree's `ebb.db` (WAL), with no JSON decode; `EntityStore.get/3` decodes the row.
- `first touch` is the dirty path (RocksDB scan + merge + SQLite write) and happens once per Entity; `clean hit` is the steady-state read.

