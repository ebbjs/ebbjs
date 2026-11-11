### ack path — `ack_window_record`, b1000 c=1, 15s window

| arm | windows | actions | Actions/s | p50 µs | p95 µs | p99 µs |
| --- | --- | --- | --- | --- | --- | --- |
| ack_window_record | 1311 | 1311000 | 87367 | 7116.75 | 43404.97 | 47644.4 |

`actions` 1311000, `appended_beyond_prewrite` 0, `batch_size` 1000, `bytes_appended` 790867215, `bytes_per_action` 508.6, `duration_s` 15, `per_100_actions_p50_us` 711.7, `prebuilt` false, `prewrite_bytes` 2100000000, `warmup_s` 3, `warmup_windows` 244, `windows` 1311

**host**: `recsy-vps`, 4 schedulers, build `397ad54f` (dirty working tree),
25.42 s wall, hypervisor steal **21.3 %**, longest scheduler pause **86.2 ms**.

- p50 includes window assembly when `prebuilt` is false, matching D3's `log_first` timed region.
- `appended_beyond_prewrite` > 0 means part of the pass left the pre-written block region and paid allocation.

