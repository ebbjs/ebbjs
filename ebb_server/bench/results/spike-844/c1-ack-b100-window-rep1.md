### ack path — `ack_window_record`, b100 c=1, 20s window

| arm | windows | actions | Actions/s | p50 µs | p95 µs | p99 µs |
| --- | --- | --- | --- | --- | --- | --- |
| ack_window_record | 8657 | 865700 | 43292 | 918.38 | 1303.42 | 59753.15 |

`actions` 865700, `appended_beyond_prewrite` 0, `batch_size` 100, `bytes_appended` 508787040, `bytes_per_action` 508.6, `duration_s` 20, `per_100_actions_p50_us` 918.4, `prebuilt` false, `prewrite_bytes` 1700000000, `warmup_s` 3, `warmup_windows` 1347, `windows` 8657

**host**: `recsy-vps`, 4 schedulers, build `397ad54f` (dirty working tree),
29.3 s wall, hypervisor steal **25.6 %**, longest scheduler pause **82.9 ms**.

- p50 includes window assembly when `prebuilt` is false, matching D3's `log_first` timed region.
- `appended_beyond_prewrite` > 0 means part of the pass left the pre-written block region and paid allocation.

