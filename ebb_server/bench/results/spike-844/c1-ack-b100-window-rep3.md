### ack path — `ack_window_record`, b100 c=1, 20s window

| arm | windows | actions | Actions/s | p50 µs | p95 µs | p99 µs |
| --- | --- | --- | --- | --- | --- | --- |
| ack_window_record | 8747 | 874700 | 43740 | 904.99 | 1269.22 | 59957.26 |

`actions` 874700, `appended_beyond_prewrite` 0, `batch_size` 100, `bytes_appended` 495393765, `bytes_per_action` 508.6, `duration_s` 20, `per_100_actions_p50_us` 905.0, `prebuilt` false, `prewrite_bytes` 1700000000, `warmup_s` 3, `warmup_windows` 994, `windows` 8747

**host**: `recsy-vps`, 4 schedulers, build `397ad54f` (dirty working tree),
29.17 s wall, hypervisor steal **27.0 %**, longest scheduler pause **85.1 ms**.

- p50 includes window assembly when `prebuilt` is false, matching D3's `log_first` timed region.
- `appended_beyond_prewrite` > 0 means part of the pass left the pre-written block region and paid allocation.

