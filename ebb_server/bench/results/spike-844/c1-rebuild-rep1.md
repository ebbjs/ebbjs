### rebuild from the log — 100000-record segment, page 1000

| records | scan s | replay s | total s | records/s | repairs | answers match |
| --- | --- | --- | --- | --- | --- | --- |
| 100000 | 4.206 | 19.833 | 25.232 | 3963 | [] | true |

`bytes_per_s` 3885253, `count` 100000, `log_bytes` 98033425, `page` 1000

**host**: `recsy-vps`, 4 schedulers, build `397ad54f` (dirty working tree),
46.64 s wall, hypervisor steal **18.3 %**, longest scheduler pause **70.5 ms**.

- `scan` is `Segment.open/1` (CRC + sparse index + torn-tail truncate); `replay` is `read_range` pages applied through the consumer step.
- `answers match` compares three probed `entity_state/1` and `action_by_id/2` pairs before and after the rebuild.

