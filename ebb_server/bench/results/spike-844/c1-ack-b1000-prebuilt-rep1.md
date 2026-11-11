### ack path — `MemoryIndex.append_window/3`, `ack_prebuilt`, b1000 c=1, 15s window

| arm | windows | actions | Actions/s | p50 µs | p95 µs | p99 µs |
| --- | --- | --- | --- | --- | --- | --- |
| ack_prebuilt | 1335 | 1335000 | 88973 | 4529.31 | 62956.58 | 67460.3 |

`actions` 1335000, `appended_beyond_prewrite` 0, `batch_size` 1000, `bytes_appended` 962968505, `bytes_per_action` 516.3, `duration_s` 15, `per_100_actions_p50_us` 452.9, `prebuilt` true, `prewrite_bytes` 2100000000, `warmup_s` 3, `warmup_windows` 530, `windows` 1335

**host**: `recsy-vps`, 4 schedulers, build `397ad54f` (dirty working tree),
26.11 s wall, hypervisor steal **31.9 %**, longest scheduler pause **87.4 ms**.

- p50 includes window assembly when `prebuilt` is false, matching D3's `log_first` timed region.
- `appended_beyond_prewrite` > 0 means part of the pass left the pre-written block region and paid allocation.

