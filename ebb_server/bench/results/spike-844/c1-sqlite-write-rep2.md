### SQLite read-model write — `SQLite.upsert_entity/2`, batches of 100

| rows | rows/action | µs/row | µs/action | rows/s |
| --- | --- | --- | --- | --- |
| 19000 | 2.0 | 794.96 | 1589.93 | 1258 |

`actions` 10000, `batch` 100, `batches` 190

**host**: `recsy-vps`, 4 schedulers, build `397ad54f` (dirty working tree),
15.88 s wall, hypervisor steal **31.7 %**, longest scheduler pause **80.2 ms**.

- One `upsert_entity/2` call per row: a GenServer call plus the statement's own transaction and component-mirror replace — the production write form.
- `rows/action` is 2.0 here (a todo row and a membership row), so `µs/action` covers both.

