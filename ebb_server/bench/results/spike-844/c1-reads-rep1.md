
21:17:53.066 [info] Running EbbServer.Sync.Router with Bandit 1.10.4 at 0.0.0.0:4981 (http)
### point read p50 — one Entity row, 10000 Entities

| read | samples | p50 µs | p95 µs | p99 µs |
| --- | --- | --- | --- | --- |
| EntityStore.get/3 (clean hit) | 10000 | 33.4 | 67.53 | 136.67 |
| EntityStore.get/3 (first touch) | 10000 | 309.31 | 1368.42 | 78549.91 |
| exqlite SELECT by id | 10000 | 26.11 | 45.48 | 71.27 |
| MemoryIndex.entity_state/1 | 10000 | 1.48 | 3.95 | 5.83 |

`entities` 10000, `found` dirty 10000/10000, clean 10000/10000, raw 10000/10000, entity_state 10000/10000, `state_over_clean` 0.04, `state_over_first_touch` 0.0

**host**: `recsy-vps`, 4 schedulers, build `397ad54f` (dirty working tree),
32.12 s wall, hypervisor steal **45.5 %**, longest scheduler pause **97.2 ms**.

- `exqlite SELECT by id` is bind + step + reset on one prepared statement against the booted tree's `ebb.db` (WAL), with no JSON decode; `EntityStore.get/3` decodes the row.
- `first touch` is the dirty path (RocksDB scan + merge + SQLite write) and happens once per Entity; `clean hit` is the steady-state read.

