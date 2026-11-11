### ack path — `ack_window_record`, b1000 c=1, 15s window

| arm | windows | actions | Actions/s | p50 µs | p95 µs | p99 µs |
| --- | --- | --- | --- | --- | --- | --- |
| ack_window_record | 1362 | 1362000 | 90777 | 6818.53 | 43808.26 | 46685.61 |

`actions` 1362000, `appended_beyond_prewrite` 0, `batch_size` 1000, `bytes_appended` 791376240, `bytes_per_action` 508.6, `duration_s` 15, `per_100_actions_p50_us` 681.9, `prebuilt` false, `prewrite_bytes` 2100000000, `warmup_s` 3, `warmup_windows` 194, `windows` 1362

**host**: `recsy-vps`, 4 schedulers, build `397ad54f` (dirty working tree),
25.12 s wall, hypervisor steal **21.7 %**, longest scheduler pause **84.4 ms**.

- p50 includes window assembly when `prebuilt` is false, matching D3's `log_first` timed region.
- `appended_beyond_prewrite` > 0 means part of the pass left the pre-written block region and paid allocation.

