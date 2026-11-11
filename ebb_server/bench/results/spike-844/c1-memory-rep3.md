### in-memory index size at 100000 Actions

| shape | actions | entity rows | ETS KiB | consumer heap KiB | total KiB | bytes/action | bytes/entity | membership versions | offsets KiB | dedup KiB | entities KiB | group KiB | existence KiB | VM binary Δ KiB |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| spread (5 Updates, 2 rows) n=100000 | 100000 | 200000 | 352371 | 69660 | 422030 | 4322 | 2161 | 400000 | 6258 | 9375 | 188291 | 10939 | 137509 | 37792 |
| hot content (2 Updates, 1 row) n=100000 | 100000 | 1 | 26586 | 284 | 26870 | 275 | 27514600 | 1 | 6258 | 9382 | 4 | 10939 | 3 | 0 |
| hot membership (2 Updates, 1 row) n=2000 | 2000 | 1 | 534 | 173293 | 173828 | 89000 | 177999744 | 4001 | 130 | 177 | 4 | 220 | 3 | 3 |

`count` 100000, `gate_bytes_per_action` 1024, `shapes` [spread: 100000, hot_content: 100000, hot: 2000]

**host**: `recsy-vps`, 4 schedulers, build `397ad54f` (dirty working tree),
28.8 s wall, hypervisor steal **17.9 %**, longest scheduler pause **70.7 ms**.

- `ETS KiB` is `:ets.info(:memory)` in words × 8 for the five tables; `consumer heap KiB` is `Process.info(self(), :memory)` after a GC, which is where the `MembershipIndex` map lives.
- `bytes/action` and `bytes/entity` are on ETS + consumer heap. ETS shares refc binaries instead of copying them, so `VM binary Δ` prices the field values neither number carries.
- `spread` creates a 3-component todo row and a membership row per Action, so `bytes/entity` is meaningful there; `hot content` re-puts two fields of one row; `hot membership` is D3's u2 window at 2k Actions, because the reused membership structure's row set grows per re-put and its build cost is quadratic.
- The gate is ~1 KB per Action; a row above it says the in-memory plan does not scale.

