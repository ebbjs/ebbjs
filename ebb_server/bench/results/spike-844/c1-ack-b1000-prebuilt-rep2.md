### ack path — `MemoryIndex.append_window/3`, `ack_prebuilt`, b1000 c=1, 15s window

| arm | windows | actions | Actions/s | p50 µs | p95 µs | p99 µs |
| --- | --- | --- | --- | --- | --- | --- |
| ack_prebuilt | 1303 | 1303000 | 86792 | 4425.71 | 64425.61 | 77368.57 |

`actions` 1303000, `appended_beyond_prewrite` 0, `batch_size` 1000, `bytes_appended` 958837809, `bytes_per_action` 516.3, `duration_s` 15, `per_100_actions_p50_us` 442.6, `prebuilt` true, `prewrite_bytes` 2100000000, `warmup_s` 3, `warmup_windows` 554, `windows` 1303

**host**: `recsy-vps`, 4 schedulers, build `397ad54f` (dirty working tree),
25.3 s wall, hypervisor steal **30.2 %**, longest scheduler pause **86.8 ms**.

- p50 includes window assembly when `prebuilt` is false, matching D3's `log_first` timed region.
- `appended_beyond_prewrite` > 0 means part of the pass left the pre-written block region and paid allocation.

