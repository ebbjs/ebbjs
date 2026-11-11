### ack path — `MemoryIndex.append_window/3`, `ack`, b100 c=1, 20s window

| arm | windows | actions | Actions/s | p50 µs | p95 µs | p99 µs |
| --- | --- | --- | --- | --- | --- | --- |
| ack | 6930 | 693000 | 34653 | 1134.71 | 2022.72 | 60678.45 |

`actions` 693000, `appended_beyond_prewrite` 0, `batch_size` 100, `bytes_appended` 409560740, `bytes_per_action` 525.1, `duration_s` 20, `per_100_actions_p50_us` 1134.7, `prebuilt` false, `prewrite_bytes` 1700000000, `warmup_s` 3, `warmup_windows` 869, `windows` 6930

**host**: `recsy-vps`, 4 schedulers, build `397ad54f` (dirty working tree),
28.41 s wall, hypervisor steal **29.6 %**, longest scheduler pause **84.6 ms**.

- p50 includes window assembly when `prebuilt` is false, matching D3's `log_first` timed region.
- `appended_beyond_prewrite` > 0 means part of the pass left the pre-written block region and paid allocation.

