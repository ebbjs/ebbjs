### SQLite read-model write — `SQLite.upsert_entity/2`, batches of 100

| rows | rows/action | µs/row | µs/action | rows/s |
| --- | --- | --- | --- | --- |
| 19000 | 2.0 | 840.94 | 1681.88 | 1189 |

`actions` 10000, `batch` 100, `batches` 190

**host**: `recsy-vps`, 4 schedulers, build `397ad54f` (dirty working tree),
16.86 s wall, hypervisor steal **35.5 %**, longest scheduler pause **81.2 ms**.

- One `upsert_entity/2` call per row: a GenServer call plus the statement's own transaction and component-mirror replace — the production write form.
- `rows/action` is 2.0 here (a todo row and a membership row), so `µs/action` covers both.

