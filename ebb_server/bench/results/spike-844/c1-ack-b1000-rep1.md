### ack path — `MemoryIndex.append_window/3`, `ack`, b1000 c=1, 15s window

| arm | windows | actions | Actions/s | p50 µs | p95 µs | p99 µs |
| --- | --- | --- | --- | --- | --- | --- |
| ack | 795 | 795000 | 52995 | 10431.12 | 57957.29 | 63689.49 |

`actions` 795000, `appended_beyond_prewrite` 0, `batch_size` 1000, `bytes_appended` 545847340, `bytes_per_action` 525.4, `duration_s` 15, `per_100_actions_p50_us` 1043.1, `prebuilt` false, `prewrite_bytes` 2100000000, `warmup_s` 3, `warmup_windows` 244, `windows` 795

**host**: `recsy-vps`, 4 schedulers, build `397ad54f` (dirty working tree),
25.6 s wall, hypervisor steal **26.6 %**, longest scheduler pause **86.7 ms**.

- p50 includes window assembly when `prebuilt` is false, matching D3's `log_first` timed region.
- `appended_beyond_prewrite` > 0 means part of the pass left the pre-written block region and paid allocation.

