### consumer apply — `MemoryIndex.apply_window/2` (window 100)

| shape | records | records/s | µs/record | applied | lag after |
| --- | --- | --- | --- | --- | --- |
| spread (5 Updates, 2 rows) n=100000 | 95000 | 5797 | 172.49 | 100000 | 0 |
| hot content (2 Updates, 1 row) n=100000 | 95000 | 21546 | 46.41 | 100000 | 0 |
| spread (5 Updates, 2 rows) decode only n=100000 | 100000 | 50554 | 19.78 | 0 | — |
| hot membership (2 Updates, 1 row) n=1000 | 950 | 3208 | 311.69 | 1000 | 0 |
| hot membership (2 Updates, 1 row) n=2000 | 1900 | 851 | 1175.69 | 2000 | 0 |
| hot membership (2 Updates, 1 row) n=4000 | 3800 | 405 | 2468.95 | 4000 | 0 |

`count` 100000, `hot_ladder` [1000, 2000, 4000], `window` 100

**host**: `recsy-vps`, 4 schedulers, build `397ad54f` (dirty working tree),
51.12 s wall, hypervisor steal **22.2 %**, longest scheduler pause **184.3 ms**.

- Records are appended outside the timer and applied in windows of 100, the design's catch-up/applier unit.
- One consumer process applies all five derived indexes. The design splits them across an entity consumer, an existence consumer and group partitions, so this is the single-process worst case rather than the designed shape.
- `decode only` is the same records through `ActionFormat.decode/2` with no index work, so the gap is the derivation cost on this host.
- `hot content` is a document being edited (two field Updates on one row, no membership Update); `hot membership` is D3's u2 window.
- `hot membership` grows ~2× per doubling of the record count: a re-put of the same membership row appends another row ref to `MembershipIndex`'s `{:rows, entity_id}` list (and another version), so the projection walks an ever-longer row set. That is a bug in the reused D2 structure, not in the log-derived read models.

