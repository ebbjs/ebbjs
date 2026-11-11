### ack path — `MemoryIndex.append_window/3`, `ack`, b100 c=1, 20s window

| arm | windows | actions | Actions/s | p50 µs | p95 µs | p99 µs |
| --- | --- | --- | --- | --- | --- | --- |
| ack | 6476 | 647600 | 32383 | 1203.38 | 2256.05 | 60937.63 |

`actions` 647600, `appended_beyond_prewrite` 0, `batch_size` 100, `bytes_appended` 399303740, `bytes_per_action` 525.1, `duration_s` 20, `per_100_actions_p50_us` 1203.4, `prebuilt` false, `prewrite_bytes` 1700000000, `warmup_s` 3, `warmup_windows` 1128, `windows` 6476

**host**: `recsy-vps`, 4 schedulers, build `397ad54f` (dirty working tree),
29.59 s wall, hypervisor steal **29.0 %**, longest scheduler pause **84.5 ms**.

- p50 includes window assembly when `prebuilt` is false, matching D3's `log_first` timed region.
- `appended_beyond_prewrite` > 0 means part of the pass left the pre-written block region and paid allocation.

