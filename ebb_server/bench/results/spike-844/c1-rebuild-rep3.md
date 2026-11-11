### rebuild from the log — 100000-record segment, page 1000

| records | scan s | replay s | total s | records/s | repairs | answers match |
| --- | --- | --- | --- | --- | --- | --- |
| 100000 | 2.902 | 18.622 | 22.69 | 4407 | [] | true |

`bytes_per_s` 4320521, `count` 100000, `log_bytes` 98033425, `page` 1000

**host**: `recsy-vps`, 4 schedulers, build `397ad54f` (dirty working tree),
42.63 s wall, hypervisor steal **16.9 %**, longest scheduler pause **72.0 ms**.

- `scan` is `Segment.open/1` (CRC + sparse index + torn-tail truncate); `replay` is `read_range` pages applied through the consumer step.
- `answers match` compares three probed `entity_state/1` and `action_by_id/2` pairs before and after the rebuild.

