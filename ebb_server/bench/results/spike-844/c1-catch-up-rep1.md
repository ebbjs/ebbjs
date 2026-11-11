### catch-up page p50 — 100 Actions by group, 100000-Action log

| page source | samples | p50 µs | p95 µs | p99 µs | page size |
| --- | --- | --- | --- | --- | --- |
| group index seek only (`group_gsns/4`) | 500 | 47.01 | 63.56 | 73.89 | 100 |
| seek + dense offset read (`read: :offsets`) | 500 | 2181.32 | 63471.47 | 144628.45 | 100 |
| seek + sparse `Segment.read/2` (`read: :sparse`) | 100 | 86300.85 | 179695.99 | 186458.34 | 100 |

`log_actions` 100000, `page` 100, `sources_agree` true

**host**: `recsy-vps`, 4 schedulers, build `397ad54f` (dirty working tree),
33.41 s wall, hypervisor steal **20.0 %**, longest scheduler pause **74.1 ms**.

- `Segment.read/2` selects the nearest sparse sample then walks forward, so a scattered page costs up to 63 record reads per GSN; the dense `gsn -> offset` table turns it into two `pread`s.
- `sources_agree` compares the first 50 pages read by each source for the same GSNs.

