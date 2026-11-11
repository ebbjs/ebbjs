# C1 — segments are the source of truth, everything else derived (in-memory indexes)

Measured **2026-11-11** on `recsy-vps` (AMD EPYC 7763, **4 schedulers**, 15 GiB,
ext4 `/dev/sda1`), Elixir 1.17.3 / OTP 27, build **`397ad54f`** on
`spike/844-log-first-write-path` (base `f7fea86f`). 3 s warmup, 20 s window
(15 s for b1000), `--seed 1`, fresh data dir per pass, 3 interleaved reps,
every measured invocation under `flock /tmp/spike-844-bench.lock`. Raw reports:
`bench/results/spike-844/c1-*.md` (one file per arm per rep).

Reproduce: `./bench/memory_index_diff.sh` (see the script header for the arm
list and the pre-write budgets).

Prototype: `lib/ebb_server/storage/log_first/memory_index.ex`.
Harness: `bench/ebb_server/bench/memory_index_diff.ex`.

## Host noise (per measurement block, medians of 3 reps)

| block                        | hypervisor steal | longest scheduler pause |
| ---------------------------- | ---------------: | ----------------------: |
| ack b100 (records)           |            29.0 % |                 85 ms |
| ack b1000 (records)          |            26.6 % |                 86 ms |
| ack b100 (records, prebuilt) |            30.6 % |                 84 ms |
| ack b1000 (records, prebuilt)|            30.2 % |                 86 ms |
| ack b100 (window record)     |            27.0 % |                 83 ms |
| ack b1000 (window record)    |            21.7 % |                 86 ms |
| consumer apply               |            22.2 % |                 75 ms |
| point reads                  |            34.2 % |                 77 ms |
| catch-up page                |            20.7 % |                 75 ms |
| memory                       |            17.9 % |                 70 ms |
| rebuild                      |            18.3 % |                 72 ms |
| SQLite read-model write      |            34.1 % |                 81 ms |
| window-write component probe |            28.8 % |                 80 ms |

## (a) ack path — append + `datasync`, p50 µs (lower is better)

| arm                                                        |  b100 p50 | b1000 p50 | per 100 Actions @b1000 | Actions/s (median) |
| ---------------------------------------------------------- | --------: | --------: | ---------------------: | -----------------: |
| window record, the design's §2 body (assembly + append)     | **918.4** | **6,818.5** | 682 | 43,292 / 90,777 |
| one record per Action (assembly + append)                   | 1,134.7 | 9,608.8 | 961 | 34,417 / 55,043 |
| one record per Action, frames built before the window       | 470.1 | 4,493.8 | 449 | 56,543 / 88,973 |
| D3 `log_first_recycled` (published, earlier session)        | 960 | 7,349 | 735 | 41,410 / 72,300 |

Window record at b100: 918.38 / 949.75 / 904.99. Per-Action records at b100:
1,134.71 / 1,203.38 / 1,114.24 — the median passes the ≤1,150 µs gate, one rep
does not, so the per-Action shape sits on the gate rather than under it.

### Why the two shapes differ — component probe (b1000, 300 windows each)

Same bytes, same fd, same pre-written (in-place) block state, one `datasync` per
window:

| write shape                                                       | p50 µs | p95 µs |
| ----------------------------------------------------------------- | -----: | -----: |
| `Segment.append/3` with 1,000 records, log < 0.5M records          | 2,286.8 | 4,562 |
| `Segment.append/3` with 1,000 records, log > 1.7M (index 28,125)   | 6,014.7 | 76,486 |
| one contiguous window binary + `datasync` (D3's shape)             | 1,154.6 | 1,582 |

`Segment.append/3` maintains its sparse index with `index ++ [sample]`, so every
append copies the whole index; at b1000 that is ~15 copies per window and the
cost grows with the log's length. Its per-record framing also means the window
reaches `:file.pwrite/3` as ~2,000 iodata fragments instead of one binary.

## (b) consumer apply — records/s and µs/record (higher / lower is better)

100k Actions, applied in windows of 100, one consumer process, all five derived
indexes:

| shape                                     | records/s | µs/record | median µs/record |
| ----------------------------------------- | --------: | --------: | ---------------: |
| spread (5 Updates, 2 rows)                | 5,163–5,798 | 172.5–193.7 | 172.5 |
| hot content (2 Updates, 1 row)            | 18,545–21,546 | 46.4–53.9 | 48.9 |
| spread, decode only (no index work)       | 47,908–50,554 | 19.8–20.9 | 20.2 |
| hot membership (2 Updates, 1 row), 1k     | 2,621–3,208 | 311.7–381.5 | 381.5 |
| hot membership, 2k                        | 824–872 | 1,146.7–1,213.1 | 1,146.7 |
| hot membership, 4k                        | 405–453 | 2,207.2–2,468.9 | 2,207.2 |

The `hot membership` ladder is quadratic: D3's u2 window re-puts one membership
row twice per Action, and `MembershipIndex`'s `add_row_ref/4` appends a
duplicate row ref (and a new list version) on every re-put, so the projection
walks an ever-longer row set. A bug in the reused D2 structure, not in the
derived read models.

## (c) point read p50 µs — 10k Entities (lower is better)

| read                               |   p50 |   p95 | median of 3 reps |
| ---------------------------------- | ----: | ----: | ---------------: |
| `EntityStore.get/3` (clean hit)     | 26.3–33.4 | 49.1–67.5 | 31.28 |
| `EntityStore.get/3` (first touch)   | 255.5–430.6 | 763–1,473 | 309.31 |
| `exqlite` SELECT by id (no decode)  | 16.4–26.1 | 26.7–45.5 | 19.14 |
| `MemoryIndex.entity_state/1`        | 1.22–1.48 | 1.96–3.95 | **1.34** |

`entity_state/1` is 23× the `EntityStore.get/3` clean hit, so the "within 2×"
gate is met with a wide margin.

## (d) catch-up page p50 µs — 100 Actions by group, 100k-Action log (lower is better)

| page source                                        | p50 (median) | p95 (median) | p99 (median) |
| -------------------------------------------------- | -----------: | -----------: | -----------: |
| group index seek only (`group_gsns/4`)              | 47.0 | 63.6 | 73.9 |
| seek + dense offset read (`read: :offsets`)         | 2,181.3 | 63,471 | 139,946 |
| seek + sparse `Segment.read/2` (`read: :sparse`)    | 110,860.3 | 179,696 | 186,458 |

The dense-offset page is ~20 µs per Action, i.e. `ActionFormat.decode/2` plus
two `pread`s. The sparse read is ~1.1 ms per Action: `Segment.read/2` starts at
the nearest 64th-record sample and walks forward, so a scattered page pays up
to 63 record reads per GSN.

## (e) memory at 100k Actions (lower is better; ~1 KB/action is the gate)

| shape                          | ETS KiB | consumer heap KiB | bytes/action | bytes/entity | membership versions |
| ------------------------------ | ------: | ----------------: | -----------: | -----------: | ------------------: |
| spread (5 Updates, 2 rows)      | 352,371 | 69,660 | **4,322** | 2,161 | 400,000 |
| hot content (2 Updates, 1 row)  | 26,586 | 295 | **275** | — (1 row) | 1 |
| hot membership, 2k (quadratic)  | 534 | 173,288 | 88,997 | — (1 row) | 4,001 |

Spread breakdown per table: entities 188,291 KiB (45 %), existence 137,509 KiB
(33 %), group 10,939 KiB, dedup 9,375 KiB, offsets 6,258 KiB, membership map
69,660 KiB (16 %). Measured identically in all three reps (ETS size is
deterministic); the `hot membership` row is the D2 row-ref bug, not a read
model.

## (f) rebuild from the log — 100k-Action segment (lower is better)

| measure                        |     median |           range |
| ------------------------------ | ---------: | --------------: |
| total wall clock               | **25.23 s** | 22.69–33.21 s |
| `Segment.open/1` scan          | 4.21 s | 2.90–10.86 s |
| replay through the consumer    | 19.83 s | 18.62–21.13 s |
| records/s                      | 3,963 | 3,011–4,407 |
| repairs                        | `[]` | — |
| answers identical before/after | yes | — |

## (g) SQLite read-model write (lower is better)

`SQLite.upsert_entity/2`, one call per row, batches of 100, 2 rows per Action:

| measure     | median | range |
| ----------- | -----: | ----: |
| µs/row      | 798.5 | 795.0–840.9 |
| µs/action   | 1,597.0 | 1,589.9–1,681.9 |
| rows/s      | 1,252 | 1,189–1,258 |

## Gate verdicts

| gate                                                | verdict |
| --------------------------------------------------- | ------- |
| ack ≤1,150 µs per 100-Action flush at b100           | **pass** — window record 918, per-Action records 1,135 (one rep 1,203) |
| point read within 2× of `EntityStore.get/3` p50      | **pass** — 1.34 vs 31.28 µs (23× better) |
| report memory; ~1 KB/action is the scaling gate      | **miss at the 5-Update/2-row shape** (4.3 KB/action), **pass at the hot-content shape** (275 B/action) |
