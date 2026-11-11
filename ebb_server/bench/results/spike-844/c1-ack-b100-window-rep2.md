### ack path — `ack_window_record`, b100 c=1, 20s window

| arm | windows | actions | Actions/s | p50 µs | p95 µs | p99 µs |
| --- | --- | --- | --- | --- | --- | --- |
| ack_window_record | 8187 | 818700 | 40941 | 949.75 | 1375.45 | 59578.79 |

`actions` 818700, `appended_beyond_prewrite` 0, `batch_size` 100, `bytes_appended` 484393965, `bytes_per_action` 508.6, `duration_s` 20, `per_100_actions_p50_us` 949.7, `prebuilt` false, `prewrite_bytes` 1700000000, `warmup_s` 3, `warmup_windows` 1338, `windows` 8187

**host**: `recsy-vps`, 4 schedulers, build `397ad54f` (dirty working tree),
29.1 s wall, hypervisor steal **29.2 %**, longest scheduler pause **82.8 ms**.

- p50 includes window assembly when `prebuilt` is false, matching D3's `log_first` timed region.
- `appended_beyond_prewrite` > 0 means part of the pass left the pre-written block region and paid allocation.

