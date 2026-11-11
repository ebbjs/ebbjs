### catch-up page p50 — 100 Actions by group, 100000-Action log

| page source | samples | p50 µs | p95 µs | p99 µs | page size |
| --- | --- | --- | --- | --- | --- |
| group index seek only (`group_gsns/4`) | 500 | 46.43 | 60.87 | 68.25 | 100 |
| seek + dense offset read (`read: :offsets`) | 500 | 2053.51 | 62600.78 | 139945.61 | 100 |
| seek + sparse `Segment.read/2` (`read: :sparse`) | 100 | 110860.25 | 183670.67 | 184758.37 | 100 |

`log_actions` 100000, `page` 100, `sources_agree` true

**host**: `recsy-vps`, 4 schedulers, build `397ad54f` (dirty working tree),
36.79 s wall, hypervisor steal **21.5 %**, longest scheduler pause **74.7 ms**.

- `Segment.read/2` selects the nearest sparse sample then walks forward, so a scattered page costs up to 63 record reads per GSN; the dense `gsn -> offset` table turns it into two `pread`s.
- `sources_agree` compares the first 50 pages read by each source for the same GSNs.

