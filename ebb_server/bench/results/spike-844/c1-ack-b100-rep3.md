### ack path — `MemoryIndex.append_window/3`, `ack`, b100 c=1, 20s window

| arm | windows | actions | Actions/s | p50 µs | p95 µs | p99 µs |
| --- | --- | --- | --- | --- | --- | --- |
| ack | 6883 | 688300 | 34417 | 1114.24 | 2073.09 | 60017.86 |

`actions` 688300, `appended_beyond_prewrite` 0, `batch_size` 100, `bytes_appended` 423289340, `bytes_per_action` 525.2, `duration_s` 20, `per_100_actions_p50_us` 1114.2, `prebuilt` false, `prewrite_bytes` 1700000000, `warmup_s` 3, `warmup_windows` 1177, `windows` 6883

**host**: `recsy-vps`, 4 schedulers, build `397ad54f` (dirty working tree),
29.5 s wall, hypervisor steal **27.2 %**, longest scheduler pause **86.0 ms**.

- p50 includes window assembly when `prebuilt` is false, matching D3's `log_first` timed region.
- `appended_beyond_prewrite` > 0 means part of the pass left the pre-written block region and paid allocation.

