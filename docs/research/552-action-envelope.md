# The stored Action envelope (#552)

What a committed Action looks like in `cf_actions`, priced per read path and
settled with numbers. This is a decision note plus the measurement harness that
decides it (`mix bench.envelope`); the format change it lands is small and the
measurement is the deliverable.

Implements the decision in `EbbServer.Storage.ActionFormat`, and the version
byte that makes the next stored-shape change (#575) a migration instead of
another one-way door.

## What this decides

1. Every stored value carries a format version, as byte 0.
2. The per-Update `update_scopes` live **beside** the payload in the same value,
   not inside the same decoded term and not in a second record:

   ```
   <<1, payload_bytes::32, payload_etf::binary, scopes_etf::binary>>
   ```

3. A reader who only needs Updates — materialization, query, group listing, the
   boot backfill — slices the payload out and never decodes the scopes.
4. The dual-shape reader from #532 is extended once, to three shapes, and stays
   the only way a `cf_actions` value is read.

## Where this fits

Workstream B of [epic #529](https://github.com/ebbjs/ebbjs/issues/529). It is
not the throughput prize: the durable write is bounded by op count and fsync,
and the envelope is ~0.6 µs of encode per Action inside a flush whose floor is
milliseconds. It buys two other things.

- **A cheaper read.** Every read of the log decodes the envelope. Today it
  decodes a tuple to reach the payload it wants, and materialization decodes the
  delivery scopes it never uses.
- **The versioning prerequisite for #575.** [#575](https://github.com/ebbjs/ebbjs/issues/575)
  decides what `cf_entity_actions` is for, and that is a schema change on the
  same value. Landing it on the unversioned dual-shape reader would stack two
  migrations on one heuristic. The version byte is what makes the second one a
  normal migration.

## The four shapes compared

| Shape               | `cf_actions` value                                | Version       | Terms decoded, full read | Terms decoded, payload-only read | Durable puts / Action |
| ------------------- | ------------------------------------------------- | ------------- | -----------------------: | -------------------------------: | --------------------: |
| `wrapper` (today)   | `term_to_binary({payload_etf, update_scopes})`    | none          |                        2 |                                2 |                     1 |
| `versioned_wrapper` | `term_to_binary({1, payload_etf, update_scopes})` | tuple element |                        2 |                                2 |                     1 |
| `companion`         | `payload_etf`, scopes under a second key          | none          |        1 (+1 point read) |                                1 |                     2 |
| `frame` (chosen)    | `<<1, size::32, payload_etf, scopes_etf>>`        | byte 0        |                        2 |                            **1** |                     1 |

`versioned_wrapper` is in the comparison because it is the smallest possible
versioning change: if it were enough, the frame would not be worth the format
change. `companion` is the alternative #532 proposed and never measured —
"storing `update_scopes` beside the payload instead of inside the same term".

The frame is the only shape that is both one durable put and one decode on the
paths that do not need scopes. That is the whole argument, and the rest of this
note is what it costs.

## What each reader actually needs

| Reader                                | Path                                                    | Reads the scopes? |
| ------------------------------------- | ------------------------------------------------------- | ----------------- |
| `EntityStore.load_actions/2`          | cold/dirty materialize, group listing, query-when-dirty | no                |
| `SystemCache` boot backfill           | boot                                                    | no                |
| `ActionLog.read/3`                    | Action export                                           | yes               |
| `Sync.CatchUp.fetch_actions_by_gsn/1` | catch-up                                                | yes               |
| `Sync.FanOutRouter.push_gsn_range/4`  | live fan-out                                            | yes               |

Two of the five reads only ever want the Updates, and materialization is the
one on the user's interaction path.

## Method

Harness: `mix bench.envelope` (new). It compares the four shapes on one booted
storage tree, each shape in its own disjoint GSN window, so every shape's
samples see the same WAL, compaction state and block cache. Samples are
**interleaved with a rotated shape order**, so host drift lands on every shape
equally instead of on whichever shape was measured last.

Three legs:

- **Encode leg** — the per-Action value construction alone
  (`cf_actions_value + extra_ops`), no RocksDB. This is the envelope's own write
  price, separable from op assembly and fsync.
- **Write leg** — one `RocksDB.write_batch(ops, sync: true)` per sample, holding
  the full flush shape (`cf_actions` in the shape under test plus the dedup,
  group-index, entity-index rows and the flush-scoped type-entity rows the
  Writer commits). Action construction, validation, encoding, key building and
  batch assembly are outside the timer, as in `EbbServer.Bench.WriteBatch`.
- **Read legs** — three path models, each doing the same gets and the same
  decode calls as the production function it names:
  `materialize` (`multi_get` + `decode_payload`, `EntityStore.load_actions/2`),
  `catch_up` (`multi_get` + full decode + `ActionScope.updates_for_group/2`),
  `export` (`range_iterator` + full decode, `ActionLog.read/3`). For
  `companion`, the second point read is inside the timed decode.

`query` and group listing do not get their own row: they reach the envelope
only through `EntityStore.materialize/2` (`query` for its dirty ids, group
listing per row), so they share the `materialize` price.

Every sample is divided by the Actions it consumed. `--runs` is a floor, not
the sample size: the runner measures at least 51 flushes per size and 1,000
read samples per path, because a few-millisecond window on a shared host lets
one scheduler hiccup decide a p50.

Where each of the issue's read paths is priced:

| Path                                                 | Priced by                                                                                                                                       |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `commit_latency_ms` split, 100 and 152 Actions/flush | encode leg + write leg (the encode leg is the missing piece of the split; `commit_latency_ms` still spans both)                                 |
| cold materialize                                     | `materialize` read leg, plus the `actions_load` phase of `mix bench.materialize` at the operating point                                         |
| dirty materialize                                    | same (the dirty path's `actions_load` is the same `multi_get` + decode)                                                                         |
| query                                                | the `materialize` read leg: `query` materializes its dirty ids through the same function, and its own sample is SQLite + JSON, not the envelope |
| catch-up                                             | `catch_up` read leg                                                                                                                             |
| export                                               | `export` read leg                                                                                                                               |
| group listing                                        | the `materialize` read leg: it materializes each row through `EntityStore.materialize/2`                                                        |

Two things the issue's Measurement section names are covered differently, and
deliberately:

- **`t5` is the write leg.** `EbbServer.Bench.WriteBatch` _is_ the t5 recipe —
  a raw `write_batch` with no Writer, cache, or watermark — so the write leg
  runs it with the stored value under test and at both flush sizes. `t5
--ablate build,encode` prices the payload build and ETF encode that #532
  moved before the claim, which is upstream of the envelope and unchanged
  here, so it is not the instrument for this question. The encode leg is.
- **Flush size does not enter a read leg.** A read decodes one Action at a
  time; its cost does not depend on how many Actions shared the flush that
  committed it. The 100/152 axis is therefore priced where it exists — the
  write leg and the operating point — and the read legs are per Action.

Reproduce with:

```sh
cd ebb_server
mix bench.envelope --flush-sizes 100,152 --reads 1000 --runs 3
```

## Results

Host: `recsy-vps`, AMD EPYC 7763, 4 schedulers for the BEAM, Elixir 1.17.3 /
OTP 27, temp DB, `sync: true` — the same host and shape as
[the #515 profile](515-materialization-profile.md) and the #529 benches. Two
independent runs (A and B) are tabulated. Three further runs (C–E, after a
harness refactor that shared the flush op list with the t5 spike) reproduced
every ordering in them with one exception, noted below. Every number here is
**[measured]**.

### Encode leg — the envelope's own write price

µs/Action p50, 1,000 Actions per sample, no RocksDB:

| Shape               |    Run A |    Run B | min (A / B) |
| ------------------- | -------: | -------: | ----------: |
| `wrapper`           |     0.48 |     0.47 | 0.33 / 0.34 |
| `versioned_wrapper` |     0.46 |     0.49 | 0.31 / 0.31 |
| `companion`         | **0.38** | **0.37** | 0.22 / 0.21 |
| `frame`             |     0.59 |     0.57 | 0.32 / 0.33 |

The companion encodes cheapest because it encodes only the payload; the frame
pays one small `term_to_binary` of the scopes plus the final copy, which is
0.05–0.10 µs/Action more than today's wrapper across the five runs. Per
100-Action flush that is 0.005–0.01 ms of a ~1.8 ms flush; per 152 it is
0.008–0.015 ms of ~2.4 ms.

### Write leg — the durable flush is shape-blind

One `write_batch(sync: true)` per sample, 51 samples per cell, shapes
interleaved in one boot. ms/flush p50:

| Shape               | 100 A/flush (A / B) | 152 A/flush (A / B) |
| ------------------- | ------------------: | ------------------: |
| `wrapper`           |         1.86 / 1.70 |         2.45 / 2.16 |
| `versioned_wrapper` |         1.88 / 1.69 |         2.48 / 2.22 |
| `companion`         |         2.11 / 1.86 |         2.72 / 2.54 |
| `frame`             |         1.92 / 1.68 |         2.40 / 2.15 |

The three single-record shapes are within ±3% of each other in both runs,
i.e. inside the write leg's own noise band, and the encode leg says their
entire difference is 0.01–0.015 ms/flush. The **companion doubles the durable
put** and pays for it: +0.15–0.35 ms/flush at both sizes in both runs (+8–13%
over the frame). Its value is also the only one that is _larger_ on disk, not
smaller (see the bytes table).

### Read legs — where the frame wins

µs/Action p50, shape order rotated per pass inside one boot:

| Path                                          | `wrapper` (A / B) | `versioned_wrapper` (A / B) | `companion` (A / B) | `frame` (A / B) |
| --------------------------------------------- | ----------------: | --------------------------: | ------------------: | --------------: |
| `materialize` (`EntityStore.load_actions/2`)  |       3.75 / 4.75 |                 3.75 / 4.50 |         3.69 / 4.38 | **3.69 / 4.38** |
| `catch_up` (`CatchUp.fetch_actions_by_gsn/1`) |       4.84 / 5.48 |                 4.82 / 5.54 |         8.00 / 8.15 | **4.74 / 5.22** |
| `export` (`ActionLog.read/3`)                 |      10.35 / 6.36 |                10.60 / 6.62 |        16.19 / 8.79 | **9.41 / 5.75** |

- **`frame` is the cheapest single-record shape on every path**, by 2–8% on
  `materialize`, 2–5% on `catch_up`, and 5–10% on `export`, and every one of
  the five runs agrees on the direction. `materialize` is where the win is
  smallest because the `multi_get` dominates the decode there; it is also the
  path that matters most, since query and group listing share it.
- **Versioning alone changes nothing.** `versioned_wrapper` and `wrapper` are
  within ±3% on all three paths (they do identical decode work) — the version
  integer costs nothing and buys nothing at read time, because the payload is
  still inside the term that carries the scopes. Only pulling the scopes out
  of that term does.
- **`companion` is the wrong trade.** On `materialize` it is a wash to 9%
  ahead (equal in A and B; 4.81 vs 5.13 and 4.13 vs 4.56 µs in D and E) —
  its value is 6% smaller and that path is `multi_get`-bound, which is the
  one place the smaller value pays. Everywhere else it costs, and it is not
  close: its second point read makes `catch_up` **+56–72%** and `export`
  **+53–72%** (all five runs), and its second durable put adds **+8–13%** to
  a flush. The path the win is on is the one that matters least to this
  decision, because it is also the path with the most headroom (JSON, not the
  envelope, is 81% of a dirty materialize).

`export`'s absolute level differs between runs (10.35 vs 6.36 µs/Action for
`wrapper`) because a 200-GSN range scan is the most allocation- and
cache-sensitive model here. The comparison is within-run, interleaved, and
consistent: `frame` is 5–10% cheaper than `wrapper` on it.

### Stored bytes per Action

| Shape               | `cf_actions` value (B) | Extra key+value (B) | Total (B) | Durable puts / Action |
| ------------------- | ---------------------: | ------------------: | --------: | --------------------: |
| `wrapper`           |                    781 |                   0 |       781 |                     1 |
| `versioned_wrapper` |                    783 |                   0 |       783 |                     1 |
| `companion`         |                    731 |                  76 |   **807** |                     2 |
| `frame`             |                **779** |                   0 |   **779** |                     1 |

The frame is the smallest single-record value: the version byte and the length
prefix cost 3 B over the wrapper, and dropping the tuple header from around
the payload pays 5 B back.

### At the operating point

The envelope is a sub-percent share of a flush, so the end-to-end runs are a
**no-regression check**, not where the decision is made. `origin/main` at
`a381b1b` vs this branch, same host, alternating runs. `mix bench.actions
--tier t0 --duration 20 --warmup 3 --concurrency 1 --batch-size 100
--updates-per-action 2 --distribution hot --seed 1` (three runs per arm):

| Arm           | `commit_latency_ms` p50 |
| ------------- | ----------------------: |
| `origin/main` |   5.17 / 5.17 / 5.27 ms |
| this branch   |   5.32 / 5.14 / 5.22 ms |

At the production configuration, `--tier t2 --concurrency 8 --batch-size 100`
(six runs per arm, median): rate **25,388 → 25,110 Actions/s** (−1.1%), client
p50 **30.09 → 30.43 ms** (+1.1%), `commit_latency_ms` p50 **1.873 → 1.859 ms**
(−0.8%). All three are inside the ±5–10% single-run spread this repo publishes
for the ceiling; the write path is unchanged.

The read side, `mix bench.materialize --sizes 1000 --runs 5 --reps 50` on the
[#515](515-materialization-profile.md) hot and spread scenarios, three
alternating runs per arm. Median p50 in µs, with the range of the three arm
medians in parentheses:

| Scenario     |       `origin/main` |          this branch |
| ------------ | ------------------: | -------------------: |
| hot cold     | 6,623 (6,519–9,426) | 9,111 (8,708–10,436) |
| hot dirty    | 3,755 (3,621–3,864) |  3,508 (3,337–3,612) |
| hot clean    | 2,433 (2,301–2,449) |  2,415 (2,348–2,508) |
| spread cold  |       683 (601–790) |        574 (550–897) |
| spread dirty |       653 (608–735) |        629 (565–668) |
| spread clean |          76 (73–90) |           75 (75–87) |
| query, K=1   |       570 (556–592) |        546 (529–569) |
| query, K=10  | 1,116 (1,089–1,208) |    1,026 (983–1,035) |
| query, K=50  | 4,452 (3,786–4,792) |  4,275 (3,782–4,882) |

**Read that table as a noise floor, not as a win or a regression.** No path is
resolvable at this scale. Hot cold is the widest: it samples five cold reads
per run, and its two arms' ranges are 6.5–9.4 ms against 8.7–10.4 ms; the
cells that never read `cf_actions` at all (hot clean, spread clean) move by
similar fractions; and the phase that _is_ the envelope — `actions_load`, the
`multi_get` plus decode — goes 889 → 800 µs mean on cold and 23.1 → 19.1 µs on
dirty. Even that phase cannot show the change on cold, because a cold
materialize decodes a 1,000-key payload where the envelope's fixed ~0.4 µs is
0.05% of the phase; on dirty, where the payload is a one-key patch, the same
fixed cost is a few percent and shows. Anything the envelope does is invisible
next to the JSON that is 81% of a dirty materialize. The per-path decision
therefore rests on the envelope bench above; this section exists to show there
is no regression to hide behind it.

A second operating-point row worth naming, `--tier t2 --concurrency 8
--batch-size 152` (three runs per arm), measured **26,668 → 24,282 Actions/s**
(−8.9%) and `commit_latency_ms` p50 **7.00 → 7.61 ms**, i.e. ≈17.4 → ≈18.5 µs
per Action. Ranges overlap (`origin/main` 25,513–27,421 Actions/s, branch
23,157–26,114) and the coalesced flush shape differs between the arms (403 vs
412 Actions/flush). The envelope cannot produce a 1.1 µs/Action move: its whole
encode share at 152 Actions is 0.015 ms of a 7.6 ms commit. `t0 c=1` and `t2
c=8 b=100` above are the configurations where the flush shape is held
constant, and they show parity. Do not read the b=152 medians as an envelope
effect.

## The decision

**Adopt the `frame` (v1), and reject the companion.**

The number that decided it: **5–10% off the `export` read, 2–5% off
`catch_up`, and 2–8% off `materialize`, for 0.05–0.10 µs/Action more encode**
— and the encode is under 1% of a flush, while the companion's alternative
costs +8–13% of a flush in durable puts and +53–72% on every path that reads
the scopes.

If the read win were ambiguous, the tie-break would be the two properties
only the frame has:

1. It is the only shape that is **one durable put and one decode** on the
   paths that do not need scopes. The wrapper needs two decodes; the
   companion needs two reads.
2. It carries a **version byte**, which the wrapper does not and the companion
   would still need. A version integer bolted onto the wrapper
   (`versioned_wrapper`) is measurably free and measurably useless: it does
   not move a single read path, so it would buy the migration and none of the
   read.

## Versioning and the read-through

Byte 0 is the format version. `1` is this frame. `ActionFormat.decode/2` and
`decode_payload/2` accept, in order of cost:

| Value                                                    | Shape               | Written by         |
| -------------------------------------------------------- | ------------------- | ------------------ |
| `<<1, size::32, payload_etf, scopes_etf>>`               | v1 frame            | this build         |
| `term_to_binary({payload_etf, update_scopes})`           | pre-#552 wrapper    | builds before #552 |
| `term_to_binary(%{"gsn" => …, "update_scopes" => …, …})` | pre-#532 legacy map | builds before #532 |
| any other version byte                                   | rejected            | —                  |

There is no writer for the two older shapes: `ActionFormat.frame/2` replaced
`wrap/2`, so a build can no longer produce them. `action_format_test.exs`
pins every shape and every rejection at the unit level, and a second test
seeds **the previous shape** (the pre-#552 wrapper) straight into
`cf_actions` and drives the real readers — `ActionLog.read/3`,
`CatchUp.catch_up_group/3`, the fan-out push, and `EntityStore.materialize/2`
— which is the fan-out/catch-up read of a previous-shape value that #552 asks
for. Corruption is separated from versioning: a truncated frame, an empty
value, an unknown version, and a decoded term that is not an Action each raise
their own `ArgumentError`, so a bad record is never reported as an unsupported
version of itself.

`#575` can now change the stored Action again: it bumps the version byte, the
reader keeps `1` as a read-through case, and the two migrations do not stack
on one heuristic.

## What this does not settle

- **Whether `cf_entity_actions` should exist.** That is
  [#575](https://github.com/ebbjs/ebbjs/issues/575), and this note only decides
  the wrapper around the payload it may stop writing. The two changes are
  sequenced so that one format change lands at a time: #575 now has a version
  byte to migrate against.
- **What the scopes mean.** They are still the per-Update group lists captured
  at claim time, index-aligned with `updates`, and still the delivery
  contract. Nothing here changes `cf_group_actions` or the delivery rules.
- **A commit-phase split in production telemetry.**
  `ebb.writer.commit_latency_ms` still spans frame encode + op assembly +
  `write_batch`. The encode leg here prices the envelope's share directly, and
  it is a per-Action constant, so a production span would report the same
  number at the cost of an event per Action per flush. Revisit if a future
  envelope change makes that share big enough to need monitoring.

## Risks and rollback

- **The frame is not one ETF term.** A tool that reads a `cf_actions` value
  with a bare `:erlang.binary_to_term/1` fails on a v1 record. That is already
  true of no other shape, and it is deliberate: the whole point is to decode
  the payload without decoding the scopes. `ActionFormat` is the only reader
  (`grep binary_to_term` over `ebb_server/lib`), and the format is pinned by
  tests.
- **Rolling back the binary.** A pre-#552 reader cannot read a v1 record: it
  would `binary_to_term/2` the whole value and get a 2-tuple of binaries, then
  fail decoding the second one as a map. As with #532, rolling back the server
  binary after new writes requires the old records to be the only ones read —
  the version byte makes that failure loud instead of silent.
- **A corrupt v1 record** raises `ArgumentError` naming the frame, not a
  misleading version complaint; a truncated frame, an empty value, and an
  unknown version each raise their own message (pinned in
  `action_format_test.exs`).

## Follow-ups

- **`#575`** decides the `cf_entity_actions` question against this format.
- **`#537`**'s flush phases now have a companion number: when `commit_wait`
  moves at the operating point, the encode leg says how much of the move can be
  the envelope. It is ~0.6 µs of a multi-millisecond flush, so normally none.
- **Group-scoped listing (#476)** and **`query`** pay the materialize price and
  will follow any future change to `EntityStore.load_actions/2`; they do not
  need their own envelope measurement while they share that path.
