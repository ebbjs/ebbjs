### component probe — window write shape (b1000, 300 windows each)

| write shape | windows | p50 µs | p95 µs | Actions/s |
| --- | --- | --- | --- | --- |
| `Segment.append/3`, 1000 records (fragmented iodata), log < 0.5M records | 300 | 2286.84 | 4562.26 | 198283 |
| `Segment.append/3`, same shape, log > 1.7M records (sparse index ~27k entries) | 300 | 6014.69 | 76486.19 | 58571 |
| one contiguous window binary + `datasync` (D3's shape) | 300 | 1154.58 | 1582.21 | 341486 |

`batch_size` 1000, `bytes_per_window` 525000, `prewrite_bytes` 600000000, `segment_index_entries_late` 28125, `windows` 300

**host**: `recsy-vps`, 4 schedulers, build `397ad54f` (dirty working tree),
24.1 s wall, hypervisor steal **28.8 %**, longest scheduler pause **79.5 ms**.

- All three write the same bytes into a pre-written (in-place) segment on the same fd and `datasync` once per window.
- The two `Segment.append/3` rows differ only in how many records the segment already holds, which is what grows its in-memory sparse index.
- The contiguous row writes what D3's `window_record` wrote: one binary per window.

