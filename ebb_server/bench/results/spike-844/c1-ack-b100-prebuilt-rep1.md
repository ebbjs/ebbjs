### ack path — `MemoryIndex.append_window/3`, `ack_prebuilt`, b100 c=1, 20s window

| arm | windows | actions | Actions/s | p50 µs | p95 µs | p99 µs |
| --- | --- | --- | --- | --- | --- | --- |
| ack_prebuilt | 12125 | 1212500 | 60635 | 463.49 | 1094.83 | 66501.45 |

`actions` 1212500, `appended_beyond_prewrite` 0, `batch_size` 100, `bytes_appended` 732462048, `bytes_per_action` 513.4, `duration_s` 20, `per_100_actions_p50_us` 463.5, `prebuilt` true, `prewrite_bytes` 1700000000, `warmup_s` 3, `warmup_windows` 2143, `windows` 12125

**host**: `recsy-vps`, 4 schedulers, build `397ad54f` (dirty working tree),
29.29 s wall, hypervisor steal **30.6 %**, longest scheduler pause **83.2 ms**.

- p50 includes window assembly when `prebuilt` is false, matching D3's `log_first` timed region.
- `appended_beyond_prewrite` > 0 means part of the pass left the pre-written block region and paid allocation.

