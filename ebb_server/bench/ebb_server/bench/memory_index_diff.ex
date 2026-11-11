defmodule EbbServer.Bench.MemoryIndexDiff do
  @moduledoc """
  Measures option C1 (#844): the segment log is the only synchronous durable
  act, every read model is derived from it, and the read models live in ETS.

  The arms are separate measurements rather than one end-to-end number,
  because the shape under test makes one claim per arm:

    - `ack/1` — the append + `datasync` the caller is acked on, with the index
      work excluded. Priced against D3's recycled-segment arm (960 µs / 7,349 µs
      at b100 / b1000).
    - `apply/1` — the consumer step, records/s and µs/record, for the `hot`
      window shape D3 priced and for a `spread` shape (two rows, five Updates
      per Action) so the per-entity cost is visible.
    - `reads/1` — `entity_state/1` against `EntityStore.get/3` and against a
      bare `exqlite` SELECT, on the same booted DB and the same population.
    - `catch_up/1` — a 100-record page by group, from the group index alone and
      with the two ways of turning GSNs into records.
    - `memory/1` — bytes per action and bytes per entity at 100k Actions, from
      `:ets.info(:memory)` plus the consumer's membership state.
    - `rebuild/1` — wall clock to throw the indexes away and replay the log.
    - `sqlite_write/1` — what mirroring the same rows into the SQLite read model
      costs per action, using `SQLite.upsert_entity/2`.

  Every arm reports the host's hypervisor steal (`/proc/stat`) and the longest
  scheduler pause a 1 ms watchdog saw, because on this host they move the
  absolute numbers more than the code does.

  Nothing here is wired into the write or read path; it measures
  `EbbServer.Storage.LogFirst.MemoryIndex`.
  """

  alias EbbServer.Bench.{Boot, ComponentIndex, LogAppend, Options, Workbook}
  alias EbbServer.Storage.{ActionFormat, EntityStore, FieldMerge, SQLite, Writer}
  alias EbbServer.Storage.LogFirst.MemoryIndex
  alias Exqlite.Sqlite3

  @select_entity_sql "SELECT id, type, data, last_gsn FROM entities WHERE id = ?"

  ## Arms

  @doc """
  The ack path: build the window's `cf_actions` frames, append and `datasync`.

  `:prebuilt` skips frame assembly, so the delta between the two arms is
  assembly rather than the append.
  """
  @spec ack(keyword()) :: map()
  def ack(opts) do
    batch = Keyword.fetch!(opts, :batch_size)
    duration = Keyword.get(opts, :duration, 20)
    warmup = Keyword.get(opts, :warmup, 3)
    prebuilt? = Keyword.get(opts, :prebuilt, false)
    shape = Keyword.get(opts, :shape, :records)
    prewrite = Keyword.get(opts, :prewrite_bytes, 0)
    config = hot_config(batch)
    ctx = workbook_ctx()

    measure(fn ->
      index = MemoryIndex.open(dir: tmp_dir("ack_#{batch}"), prewrite_bytes: prewrite)
      prebuilt = if prebuilt?, do: window_frames(config, ctx, 1), else: nil

      {index, warm_samples, warm_actions} =
        drive(index, warmup, batch, config, ctx, prebuilt, shape, 1)

      {index, samples, actions} =
        drive(index, duration, batch, config, ctx, prebuilt, shape, 1 + warm_actions)

      elapsed_ns = Enum.sum(samples)
      lat = stats(samples)
      appended = index.segment.offset
      # The segment also holds the warmup windows; per-action bytes divide by
      # every Action appended, not only the measured ones.
      appended_actions = actions + length(warm_samples) * batch
      arm = ack_arm_name(prebuilt?, shape)

      %{
        title:
          "ack path — `#{arm}`, b#{batch} c=1, " <>
            "#{duration}s window",
        table: %{
          columns: ["arm", "windows", "actions", "Actions/s", "p50 µs", "p95 µs", "p99 µs"],
          rows: [
            [
              arm,
              "#{length(samples)}",
              "#{actions}",
              rate(actions, elapsed_ns),
              us(lat.p50),
              us(lat.p95),
              us(lat.p99)
            ]
          ]
        },
        fields: %{
          batch_size: batch,
          duration_s: duration,
          warmup_s: warmup,
          prebuilt: prebuilt?,
          windows: length(samples),
          warmup_windows: length(warm_samples),
          actions: actions,
          bytes_appended: appended,
          bytes_per_action: Float.round(appended / max(appended_actions, 1), 1),
          prewrite_bytes: prewrite,
          appended_beyond_prewrite: max(appended - prewrite, 0),
          per_100_actions_p50_us: Float.round(lat.p50 / 1_000 * 100 / batch, 1)
        },
        notes: [
          "p50 includes window assembly when `prebuilt` is false, matching D3's `log_first` timed region.",
          "`appended_beyond_prewrite` > 0 means part of the pass left the pre-written block region and paid allocation."
        ]
      }
    end)
  end

  @doc """
  The consumer step: decode each record and derive every index, in windows of
  `:window`.

  `spread` runs at `:count` Actions, the scale the memory and rebuild arms use.
  `hot` runs at a small ladder instead: D3's hot window re-puts one membership
  row twice per Action, and `MembershipIndex`'s row set appends a duplicate row
  ref per re-put, so the projection is quadratic in that shape (found by this
  arm; see the notes). The ladder is what makes that visible.
  """
  @spec apply(keyword()) :: map()
  def apply(opts) do
    count = Keyword.get(opts, :count, 100_000)
    window = Keyword.get(opts, :window, 100)
    hot_ladder = Keyword.get(opts, :hot_ladder, [1_000, 2_000, 4_000])

    measure(fn ->
      rows =
        [
          apply_shape(:spread, count, window),
          apply_shape(:hot_content, count, window),
          decode_only(:spread, count)
        ] ++ Enum.map(hot_ladder, &apply_shape(:hot, &1, window))

      %{
        title: "consumer apply — `MemoryIndex.apply_window/2` (window #{window})",
        table: %{
          columns: ["shape", "records", "records/s", "µs/record", "applied", "lag after"],
          rows: rows
        },
        fields: %{count: count, window: window, hot_ladder: inspect(hot_ladder)},
        notes: [
          "Records are appended outside the timer and applied in windows of #{window}, the design's catch-up/applier unit.",
          "One consumer process applies all five derived indexes. The design splits them across an entity consumer, an existence consumer and group partitions, so this is the single-process worst case rather than the designed shape.",
          "`decode only` is the same records through `ActionFormat.decode/2` with no index work, so the gap is the derivation cost on this host.",
          "`hot content` is a document being edited (two field Updates on one row, no membership Update); `hot membership` is D3's u2 window.",
          "`hot membership` grows ~2× per doubling of the record count: a re-put of the same membership row appends another row ref to `MembershipIndex`'s `{:rows, entity_id}` list (and another version), so the projection walks an ever-longer row set. That is a bug in the reused D2 structure, not in the log-derived read models."
        ]
      }
    end)
  end

  @doc """
  Point reads: `entity_state/1` vs `EntityStore.get/3` (clean and first-touch)
  vs a bare prepared `exqlite` SELECT, over the same Entities.
  """
  @spec reads(keyword()) :: map()
  def reads(opts) do
    count = Keyword.get(opts, :count, 10_000)
    actions = for seq <- 1..count, do: ComponentIndex.build_action(3, seq)
    ids = for seq <- 1..count, do: "todo_ci_#{seq}"
    config = %Options{tier: :t0, concurrency: 1, batch_size: 100, port: 4_981}

    measure(fn ->
      boot = Boot.start(config)

      try do
        write!(actions)

        # First touch materialises through RocksDB; every later read is a clean
        # SQLite hit. Both are reported, because they are different paths.
        {dirty, dirty_rows} = timed_each(shuffle(ids), &EntityStore.get(&1, Workbook.actor_id()))

        {clean, clean_rows} = timed_each(shuffle(ids), &EntityStore.get(&1, Workbook.actor_id()))

        {raw, raw_rows} = with_sqlite(boot, fn read -> timed_each(shuffle(ids), read) end)

        index = MemoryIndex.open(dir: tmp_dir("reads"))

        frames =
          for action <- actions,
              do: MemoryIndex.frame(action, Enum.map(action.updates, fn _ -> ["g_bench"] end))

        {:ok, index, entries} = append_all(index, frames, 1_000)
        index = MemoryIndex.apply_window(index, entries)

        {memory_index, state_rows} =
          timed_each(shuffle(ids), &MemoryIndex.entity_state(index, &1))

        %{
          title: "point read p50 — one Entity row, #{count} Entities",
          table: %{
            columns: ["read", "samples", "p50 µs", "p95 µs", "p99 µs"],
            rows: [
              read_row("EntityStore.get/3 (clean hit)", clean),
              read_row("EntityStore.get/3 (first touch)", dirty),
              read_row("exqlite SELECT by id", raw),
              read_row("MemoryIndex.entity_state/1", memory_index)
            ]
          },
          fields: %{
            entities: count,
            found:
              "dirty #{found(dirty_rows)}/#{count}, clean #{found(clean_rows)}/#{count}, " <>
                "raw #{found(raw_rows)}/#{count}, entity_state #{found(state_rows)}/#{count}",
            state_over_clean: Float.round(stats(memory_index).p50 / max(stats(clean).p50, 1), 2),
            state_over_first_touch:
              Float.round(stats(memory_index).p50 / max(stats(dirty).p50, 1), 2)
          },
          notes: [
            "`exqlite SELECT by id` is bind + step + reset on one prepared statement against the booted tree's `ebb.db` (WAL), with no JSON decode; `EntityStore.get/3` decodes the row.",
            "`first touch` is the dirty path (RocksDB scan + merge + SQLite write) and happens once per Entity; `clean hit` is the steady-state read."
          ]
        }
      after
        Boot.stop(boot)
      end
    end)
  end

  @doc """
  A catch-up page filtered by group, on a `:count`-Action log.
  """
  @spec catch_up(keyword()) :: map()
  def catch_up(opts) do
    count = Keyword.get(opts, :count, 100_000)
    page = Keyword.get(opts, :page, 100)
    samples = Keyword.get(opts, :samples, 500)
    :rand.seed(:exsss, {1, 2, 3})

    measure(fn ->
      index = build_index(:spread, count, sync: true)
      froms = for _ <- 1..samples, do: :rand.uniform(count - page - 1)

      {seek, seek_pages} = timed_each(froms, &MemoryIndex.group_gsns(index, "g_bench", &1, page))

      {offsets, offset_pages} =
        timed_each(froms, fn from ->
          {:ok, records} = MemoryIndex.updates_for_group(index, "g_bench", from, page)
          records
        end)

      # `Segment.read/2` walks from the nearest sparse sample, so 100 samples
      # price it without spending the arm's time.
      sparse_froms = Enum.take(froms, 100)

      {sparse, sparse_pages} =
        timed_each(sparse_froms, fn from ->
          {:ok, records} =
            MemoryIndex.updates_for_group(index, "g_bench", from, page, read: :sparse)

          records
        end)

      agree? = Enum.take(offset_pages, 50) == Enum.take(sparse_pages, 50)

      %{
        title: "catch-up page p50 — #{page} Actions by group, #{count}-Action log",
        table: %{
          columns: ["page source", "samples", "p50 µs", "p95 µs", "p99 µs", "page size"],
          rows: [
            [
              "group index seek only (`group_gsns/4`)",
              "#{length(seek)}",
              us(stats(seek).p50),
              us(stats(seek).p95),
              us(stats(seek).p99),
              "#{length(Enum.at(seek_pages, 0))}"
            ],
            [
              "seek + dense offset read (`read: :offsets`)",
              "#{length(offsets)}",
              us(stats(offsets).p50),
              us(stats(offsets).p95),
              us(stats(offsets).p99),
              "#{length(Enum.at(offset_pages, 0))}"
            ],
            [
              "seek + sparse `Segment.read/2` (`read: :sparse`)",
              "#{length(sparse)}",
              us(stats(sparse).p50),
              us(stats(sparse).p95),
              us(stats(sparse).p99),
              "#{length(Enum.at(sparse_pages, 0))}"
            ]
          ]
        },
        fields: %{log_actions: count, page: page, sources_agree: agree?},
        notes: [
          "`Segment.read/2` selects the nearest sparse sample then walks forward, so a scattered page costs up to 63 record reads per GSN; the dense `gsn -> offset` table turns it into two `pread`s.",
          "`sources_agree` compares the first 50 pages read by each source for the same GSNs."
        ]
      }
    end)
  end

  @doc """
  Bytes per action and per entity at `:count` Actions, for the `spread` shape
  that the other arms use, and for D3's `hot` shape at the count the reused
  membership structure can carry without the quadratic row set dominating.
  """
  @spec memory(keyword()) :: map()
  def memory(opts) do
    count = Keyword.get(opts, :count, 100_000)

    shapes =
      Keyword.get(opts, :shapes, [{:spread, count}, {:hot_content, count}, {:hot, 2_000}])

    measure(fn ->
      rows =
        for {shape, actions} <- shapes do
          before_memory = vm_memory()
          index = build_index(shape, actions, sync: false)
          gc()
          after_memory = vm_memory()

          %{
            per_table: tables,
            tables: ets_bytes,
            entities: entities,
            applied: applied,
            membership_versions: versions
          } = MemoryIndex.memory(index)

          # ETS keeps its objects in its own memory, and refc binaries live off
          # heap, so the consumer's own heap is what the membership map costs.
          consumer_bytes = Process.info(self(), :memory) |> elem(1)
          total = ets_bytes + consumer_bytes

          [
            "#{shape_name(shape)} n=#{actions}",
            "#{applied}",
            "#{entities}",
            kb(ets_bytes),
            kb(consumer_bytes),
            kb(total),
            Integer.to_string(round(total / max(applied, 1))),
            Integer.to_string(round(total / max(entities, 1))),
            "#{versions}",
            kb(tables.offsets),
            kb(tables.by_action_id),
            kb(tables.entities),
            kb(tables.group_actions),
            kb(tables.existence),
            kb(max(after_memory.binary - before_memory.binary, 0))
          ]
        end

      %{
        title: "in-memory index size at #{count} Actions",
        table: %{
          columns: [
            "shape",
            "actions",
            "entity rows",
            "ETS KiB",
            "consumer heap KiB",
            "total KiB",
            "bytes/action",
            "bytes/entity",
            "membership versions",
            "offsets KiB",
            "dedup KiB",
            "entities KiB",
            "group KiB",
            "existence KiB",
            "VM binary Δ KiB"
          ],
          rows: rows
        },
        fields: %{count: count, shapes: inspect(shapes), gate_bytes_per_action: 1024},
        notes: [
          "`ETS KiB` is `:ets.info(:memory)` in words × 8 for the five tables; `consumer heap KiB` is `Process.info(self(), :memory)` after a GC, which is where the `MembershipIndex` map lives.",
          "`bytes/action` and `bytes/entity` are on ETS + consumer heap. ETS shares refc binaries instead of copying them, so `VM binary Δ` prices the field values neither number carries.",
          "`spread` creates a 3-component todo row and a membership row per Action, so `bytes/entity` is meaningful there; `hot content` re-puts two fields of one row; `hot membership` is D3's u2 window at 2k Actions, because the reused membership structure's row set grows per re-put and its build cost is quadratic.",
          "The gate is ~1 KB per Action; a row above it says the in-memory plan does not scale."
        ]
      }
    end)
  end

  @doc """
  Rebuild-from-log wall clock: discard every index and replay `:count` records.
  """
  @spec rebuild(keyword()) :: map()
  def rebuild(opts) do
    count = Keyword.get(opts, :count, 100_000)
    page = Keyword.get(opts, :page, 1_000)

    measure(fn ->
      index = build_index(:spread, count, sync: true)
      probe = for seq <- [1, 500, count], do: {"todo_ci_#{seq}", "a_ci_#{seq}"}
      before = Enum.map(probe, &probe_answers(index, &1))

      {elapsed_ns, {:ok, index, rebuilt}} =
        timed(fn -> MemoryIndex.rebuild(index, page: page) end)

      after_answers = Enum.map(probe, &probe_answers(index, &1))

      %{
        title: "rebuild from the log — #{count}-record segment, page #{page}",
        table: %{
          columns: [
            "records",
            "scan s",
            "replay s",
            "total s",
            "records/s",
            "repairs",
            "answers match"
          ],
          rows: [
            [
              "#{rebuilt.records}",
              seconds(rebuilt.scan_us),
              seconds(rebuilt.replay_us),
              seconds(elapsed_ns / 1_000),
              "#{round(rebuilt.records * 1.0e9 / max(elapsed_ns, 1))}",
              inspect(rebuilt.repairs),
              "#{before == after_answers}"
            ]
          ]
        },
        fields: %{
          count: count,
          page: page,
          log_bytes: index.segment.offset,
          bytes_per_s: round(index.segment.offset * 1.0e9 / max(elapsed_ns, 1))
        },
        notes: [
          "`scan` is `Segment.open/1` (CRC + sparse index + torn-tail truncate); `replay` is `read_range` pages applied through the consumer step.",
          "`answers match` compares three probed `entity_state/1` and `action_by_id/2` pairs before and after the rebuild."
        ]
      }
    end)
  end

  @doc """
  Component probe for the ack path's append: is the window write's cost the
  bytes and the `datasync`, or the shape the bytes are handed over in?

  `Segment.append/3` is given one record per Action, so the window reaches
  `:file.pwrite/3` as ~2 000 small iodata fragments; D3's window record wrote
  one contiguous binary. This prices both, and re-runs the frame version after
  ~1.5M records so the segment's own sparse index has grown — that index is
  maintained with `index ++ [sample]`, so every append copies it.
  """
  @spec frame_io(keyword()) :: map()
  def frame_io(opts) do
    batch = Keyword.get(opts, :batch_size, 1_000)
    windows = Keyword.get(opts, :windows, 300)
    prewrite = Keyword.get(opts, :prewrite_bytes, 600_000_000)
    config = hot_config(batch)
    ctx = workbook_ctx()
    frames = window_frames(config, ctx, 1)

    measure(fn ->
      dir = tmp_dir("io")

      index = MemoryIndex.open(dir: dir, prewrite_bytes: prewrite)
      {index, early} = drive_windows(index, frames, windows)

      # Push the segment's sparse index to the size a full 15 s b1000 pass
      # reaches, then measure the same append again.
      {index, _} = drive_windows(index, frames, 1_200)
      {index, late} = drive_windows(index, frames, windows)

      contiguous = contiguous_windows(dir, frames, windows, prewrite)

      %{
        title: "component probe — window write shape (b#{batch}, #{windows} windows each)",
        table: %{
          columns: ["write shape", "windows", "p50 µs", "p95 µs", "Actions/s"],
          rows: [
            [
              "`Segment.append/3`, #{batch} records (fragmented iodata), log < 0.5M records",
              "#{windows}",
              us(stats(early).p50),
              us(stats(early).p95),
              rate(windows * batch, Enum.sum(early))
            ],
            [
              "`Segment.append/3`, same shape, log > 1.7M records (sparse index ~27k entries)",
              "#{windows}",
              us(stats(late).p50),
              us(stats(late).p95),
              rate(windows * batch, Enum.sum(late))
            ],
            [
              "one contiguous window binary + `datasync` (D3's shape)",
              "#{windows}",
              us(stats(contiguous).p50),
              us(stats(contiguous).p95),
              rate(windows * batch, Enum.sum(contiguous))
            ]
          ]
        },
        fields: %{
          batch_size: batch,
          windows: windows,
          bytes_per_window: batch * 525,
          prewrite_bytes: prewrite,
          segment_index_entries_late: length(index.segment.index)
        },
        notes: [
          "All three write the same bytes into a pre-written (in-place) segment on the same fd and `datasync` once per window.",
          "The two `Segment.append/3` rows differ only in how many records the segment already holds, which is what grows its in-memory sparse index.",
          "The contiguous row writes what D3's `window_record` wrote: one binary per window."
        ]
      }
    end)
  end

  @doc """
  What mirroring the same rows into the SQLite read model costs per action.
  """
  @spec sqlite_write(keyword()) :: map()
  def sqlite_write(opts) do
    count = Keyword.get(opts, :count, 10_000)
    batch = Keyword.get(opts, :batch, 100)
    actions = for seq <- 1..count, do: ComponentIndex.build_action(3, seq)
    all_rows = rows_for(actions)
    rows_per_action = length(all_rows) / max(count, 1)

    measure(fn ->
      dir = tmp_dir("sqlite")
      {:ok, pid} = SQLite.start_link(data_dir: dir, name: :ebb_bench_spike_sqlite)

      try do
        {warm, rows} = Enum.split(all_rows, min(batch * 10, length(all_rows)))
        Enum.each(warm, &SQLite.upsert_entity(&1, :ebb_bench_spike_sqlite))

        {samples, counts} =
          rows
          |> Enum.chunk_every(batch)
          |> Enum.map(fn chunk ->
            timed(fn ->
              Enum.each(chunk, &SQLite.upsert_entity(&1, :ebb_bench_spike_sqlite))
              length(chunk)
            end)
          end)
          |> Enum.unzip()

        total_rows = Enum.sum(counts)
        total_ns = Enum.sum(samples)
        total_actions = total_rows / rows_per_action

        %{
          title: "SQLite read-model write — `SQLite.upsert_entity/2`, batches of #{batch}",
          table: %{
            columns: ["rows", "rows/action", "µs/row", "µs/action", "rows/s"],
            rows: [
              [
                "#{total_rows}",
                Float.round(rows_per_action, 2) |> to_string(),
                Float.round(total_ns / total_rows / 1_000, 2) |> to_string(),
                Float.round(total_ns / total_actions / 1_000, 2) |> to_string(),
                "#{round(total_rows * 1.0e9 / max(total_ns, 1))}"
              ]
            ]
          },
          fields: %{actions: count, batch: batch, batches: length(counts)},
          notes: [
            "One `upsert_entity/2` call per row: a GenServer call plus the statement's own transaction and component-mirror replace — the production write form.",
            "`rows/action` is #{Float.round(rows_per_action, 2)} here (a todo row and a membership row), so `µs/action` covers both."
          ]
        }
      after
        GenServer.stop(pid)
        File.rm_rf(dir)
      end
    end)
  end

  ## Drivers

  # One measured window of the ack path. `prebuilt` bypasses assembly, so the
  # two arms difference to the frame build rather than to the append.
  defp drive(index, seconds, batch, config, ctx, prebuilt, shape, seq) do
    deadline = now() + seconds * 1_000_000_000
    loop(index, deadline, [], 0, batch, config, ctx, prebuilt, shape, seq)
  end

  defp loop(index, deadline, samples, actions, batch, config, ctx, prebuilt, shape, seq) do
    if now() >= deadline do
      {index, samples, actions}
    else
      {elapsed, {:ok, index, _entries}} =
        timed(fn ->
          frames = prebuilt || window_frames(config, ctx, seq + actions)
          append(index, frames, shape)
        end)

      loop(
        index,
        deadline,
        [elapsed | samples],
        actions + batch,
        batch,
        config,
        ctx,
        prebuilt,
        shape,
        seq
      )
    end
  end

  defp append(index, frames, :window), do: MemoryIndex.append_window_record(index, frames)
  defp append(index, frames, :records), do: MemoryIndex.append_window(index, frames)

  defp ack_arm_name(true, _shape), do: "ack_prebuilt"
  defp ack_arm_name(false, :records), do: "ack"
  defp ack_arm_name(false, :window), do: "ack_window_record"

  defp window_frames(config, ctx, seq) do
    for offset <- 0..(config.batch_size - 1) do
      LogAppend.stored_value(config, ctx, 1, seq + offset)
    end
  end

  defp drive_windows(index, frames, windows) do
    Enum.reduce(1..windows, {index, []}, fn _, {index, samples} ->
      {elapsed, {:ok, index, _entries}} =
        timed(fn -> MemoryIndex.append_window(index, frames) end)

      {index, [elapsed | samples]}
    end)
  end

  # The same window bytes D3's `window_record` appended: one binary per window,
  # one `pwrite` and one `datasync`.
  defp contiguous_windows(dir, frames, windows, prewrite) do
    path = Path.join(dir, "contiguous.seg")
    {:ok, fd} = :file.open(path, [:raw, :binary, :read, :write])
    {:ok, _} = :file.position(fd, {:bof, prewrite})
    :ok = :file.truncate(fd)
    :ok = prewrite_file(fd, prewrite)

    {samples, _offset} =
      Enum.map_reduce(1..windows, 0, fn window, offset ->
        iodata =
          frames
          |> Enum.with_index()
          |> Enum.map(fn {body, position} ->
            gsn = (window - 1) * length(frames) + position + 1

            [
              "E8S1",
              <<1, gsn::unsigned-64, byte_size(body)::unsigned-32,
                :erlang.crc32(body)::unsigned-32>>,
              body
            ]
          end)

        binary = IO.iodata_to_binary(iodata)
        started = now()
        :ok = :file.pwrite(fd, offset, binary)
        :ok = :file.datasync(fd)
        elapsed = now() - started

        {elapsed, offset + byte_size(binary)}
      end)

    :file.close(fd)
    File.rm(path)
    samples
  end

  defp prewrite_file(fd, bytes) do
    chunk = :binary.copy(<<0>>, 1024 * 1024)

    Enum.each(0..(div(bytes, byte_size(chunk)) - 1), fn i ->
      :ok = :file.pwrite(fd, i * byte_size(chunk), chunk)
    end)

    :file.datasync(fd)
  end

  defp apply_windows(index, entries, window) do
    entries
    |> Enum.chunk_every(window)
    |> Enum.reduce(index, fn chunk, index -> MemoryIndex.apply_window(index, chunk) end)
  end

  defp apply_shape(shape, count, window) do
    index = MemoryIndex.open(dir: tmp_dir("apply_#{shape}_#{count}"))
    {:ok, index, entries} = append_all(index, frames(shape, count), 1_000)

    warm = min(div(count, 20), count)
    {warm_entries, measured} = Enum.split(entries, warm)
    index = MemoryIndex.apply_window(index, warm_entries)

    {elapsed_ns, index} = timed(fn -> apply_windows(index, measured, window) end)
    records = length(measured)

    [
      "#{shape_name(shape)} n=#{count}",
      "#{records}",
      "#{round(records * 1.0e9 / max(elapsed_ns, 1))}",
      Float.round(elapsed_ns / records / 1_000, 2) |> to_string(),
      "#{index.applied_actions}",
      "#{MemoryIndex.stats(index).lag}"
    ]
  end

  defp decode_only(shape, count) do
    index = MemoryIndex.open(dir: tmp_dir("decode_#{shape}_#{count}"))
    {:ok, _index, entries} = append_all(index, frames(shape, count), 1_000)

    {elapsed_ns, _} =
      timed(fn ->
        Enum.each(entries, fn entry -> ActionFormat.decode(entry.body, entry.gsn) end)
      end)

    [
      "#{shape_name(shape)} decode only n=#{count}",
      "#{length(entries)}",
      "#{round(length(entries) * 1.0e9 / max(elapsed_ns, 1))}",
      Float.round(elapsed_ns / length(entries) / 1_000, 2) |> to_string(),
      "0",
      "—"
    ]
  end

  defp build_index(shape, count, opts) do
    index =
      MemoryIndex.open(
        dir: tmp_dir("index_#{shape}"),
        prewrite_bytes: Keyword.get(opts, :prewrite_bytes, 0)
      )

    {:ok, index, entries} =
      append_all(index, frames(shape, count), Keyword.get(opts, :batch, 1_000))

    if Keyword.get(opts, :apply?, true),
      do: MemoryIndex.apply_window(index, entries),
      else: index
  end

  defp append_all(index, frames, batch) do
    {index, entries} =
      frames
      |> Enum.chunk_every(batch)
      |> Enum.reduce({index, []}, fn chunk, {index, acc} ->
        {:ok, index, entries} = MemoryIndex.append_window(index, chunk)
        {index, [entries | acc]}
      end)

    {:ok, index, entries |> Enum.reverse() |> List.flatten()}
  end

  defp frames(:hot, count) do
    config = hot_config(100)
    ctx = workbook_ctx()

    for seq <- 1..count do
      LogAppend.stored_value(config, ctx, 1, 1 + seq)
    end
  end

  # A hot row with no membership Updates: the shape of a document being edited,
  # where every Action lands on the same row and re-puts two of its fields.
  defp frames(:hot_content, count) do
    hlc = System.os_time(:millisecond) * 65_536

    for seq <- 1..count do
      action = %{
        id: "a_hotc_#{seq}",
        actor_id: "g_bench_actor",
        hlc: hlc,
        updates: [
          %{
            id: "u_hotc_t_#{seq}",
            subject_id: "todo_hotc",
            component: "todo/title",
            method: "replace",
            data: %{"value" => "title-#{seq}", "hlc" => hlc}
          },
          %{
            id: "u_hotc_s_#{seq}",
            subject_id: "todo_hotc",
            component: "todo/bench_sent_us",
            method: "replace",
            data: %{"value" => seq, "hlc" => hlc}
          }
        ]
      }

      MemoryIndex.frame(action, [["g_bench"], ["g_bench"]])
    end
  end

  defp frames(:spread, count) do
    for seq <- 1..count do
      action = ComponentIndex.build_action(3, seq)
      MemoryIndex.frame(action, Enum.map(action.updates, fn _ -> ["g_bench"] end))
    end
  end

  defp hot_config(batch_size) do
    %Options{
      tier: :t5,
      engine: :log_first,
      batch_size: batch_size,
      updates_per_action: 2,
      distribution: :hot,
      concurrency: 1,
      duration: 20,
      warmup: 3,
      seed: 1
    }
  end

  defp workbook_ctx do
    %{
      group_id: Workbook.group_id(),
      actor_id: Workbook.actor_id(),
      entities: [],
      hot_entity_id: "todo_bench_hot",
      hot_membership_id: "eg_bench_hot",
      seeded_actions: 0
    }
  end

  ## Reads

  # A second connection to the booted tree's SQLite file, opened once for the
  # whole arm: the read under test is the statement, not a connect.
  defp with_sqlite(boot, fun) do
    {:ok, db} = Sqlite3.open(Path.join(boot.tmp_dir, "ebb.db"))
    {:ok, stmt} = Sqlite3.prepare(db, @select_entity_sql)

    read = fn id ->
      :ok = Sqlite3.bind(stmt, [id])
      {:row, row} = Sqlite3.step(db, stmt)
      :ok = Sqlite3.reset(stmt)
      {:ok, row}
    end

    try do
      fun.(read)
    after
      Sqlite3.close(db)
    end
  end

  defp write!(actions) do
    actions
    |> Enum.chunk_every(100)
    |> Enum.each(fn chunk ->
      case Writer.write_actions(chunk) do
        {:ok, _range, []} -> :ok
        {:ok, _range, rejected} -> raise "bench action rejected: #{inspect(hd(rejected))}"
        {:error, reason} -> raise "bench write failed: #{inspect(reason)}"
      end
    end)
  end

  defp rows_for(actions) do
    actions
    |> Enum.with_index(1)
    |> Enum.flat_map(fn {action, gsn} ->
      action.updates
      |> Enum.group_by(& &1.subject_id)
      |> Enum.map(fn {id, updates} ->
        fields =
          Map.new(updates, fn update ->
            {update.field, FieldMerge.stamp(update.data, update.id)}
          end)

        model = hd(updates).model
        components = fields |> Map.keys() |> Enum.sort() |> Enum.map(&(model <> "/" <> &1))

        %{
          id: id,
          type: model,
          data: Jason.encode!(%{"fields" => fields, "components" => components}),
          created_hlc: action.hlc,
          updated_hlc: action.hlc,
          deleted_hlc: nil,
          deleted_by: nil,
          last_gsn: gsn,
          components: components
        }
      end)
    end)
  end

  defp probe_answers(index, {entity_id, action_id}) do
    {MemoryIndex.entity_state(index, entity_id), MemoryIndex.action_by_id(index, action_id)}
  end

  defp found(results) do
    Enum.count(results, fn
      {:ok, _} -> true
      _ -> false
    end)
  end

  ## Report

  @doc """
  Renders an arm's result as Markdown: a table, a fields line, and the host
  gauges the numbers have to be read against.
  """
  @spec render(map()) :: String.t()
  def render(%{title: title, table: %{columns: columns, rows: rows}} = result) do
    gauges = Map.get(result, :gauges, %{})
    dirty_note = if gauges[:dirty], do: " (dirty working tree)", else: ""

    header = "| " <> Enum.join(columns, " | ") <> " |"
    divider = "| " <> Enum.map_join(columns, " | ", fn _ -> "---" end) <> " |"
    body = Enum.map_join(rows, "\n", fn row -> "| " <> Enum.join(row, " | ") <> " |" end)

    fields =
      result
      |> Map.get(:fields, %{})
      |> Enum.sort()
      |> Enum.map_join(", ", fn {key, value} -> "`#{key}` #{fmt(value)}" end)

    notes = result |> Map.get(:notes, []) |> Enum.map_join("\n", &("- " <> &1))

    """
    ### #{title}

    #{header}
    #{divider}
    #{body}

    #{fields}

    **host**: `#{gauges[:host]}`, #{gauges[:schedulers]} schedulers, build `#{gauges[:build]}`#{dirty_note},
    #{gauges[:seconds]} s wall, hypervisor steal **#{gauges[:steal_pct]} %**, longest scheduler pause **#{gauges[:max_pause_ms]} ms**.

    #{notes}
    """
  end

  ## Gauges

  defp measure(fun) do
    gc()
    cpu_before = cpu_sample()
    started = now()
    watchdog = start_watchdog()
    result = fun.()
    elapsed = now() - started
    max_pause = stop_watchdog(watchdog)
    cpu_after = cpu_sample()

    Map.put(result, :gauges, %{
      host: host(),
      schedulers: System.schedulers_online(),
      build: build(),
      dirty: dirty?(),
      started_at: DateTime.utc_now() |> DateTime.to_iso8601(),
      seconds: Float.round(elapsed / 1.0e9, 2),
      steal_pct: steal(cpu_before, cpu_after),
      max_pause_ms: Float.round(max_pause / 1_000_000, 1)
    })
  end

  # Mirrors `EbbServer.Bench.Sampler`'s two host gauges without its storage
  # dependencies: the aggregate `cpu` line's steal field, and a 1 ms watchdog
  # that catches the hypervisor pausing a vCPU.
  defp cpu_sample do
    fields =
      "/proc/stat"
      |> File.read!()
      |> String.split("\n", parts: 2)
      |> hd()
      |> String.split()
      |> Enum.drop(1)
      |> Enum.map(&String.to_integer/1)

    %{total: fields |> Enum.take(8) |> Enum.sum(), steal: Enum.at(fields, 7, 0)}
  end

  defp steal(before_cpu, after_cpu) do
    total = max(after_cpu.total - before_cpu.total, 1)
    Float.round(max(after_cpu.steal - before_cpu.steal, 0) * 100 / total, 1)
  end

  defp start_watchdog do
    spawn(fn -> watchdog(now(), 0) end)
  end

  defp watchdog(last, max_gap) do
    receive do
      {:stop, from, ref} ->
        send(from, {:max_pause, ref, max_gap})
    after
      1 ->
        now = now()
        watchdog(now, max(max_gap, now - last))
    end
  end

  defp stop_watchdog(watchdog) do
    ref = make_ref()
    send(watchdog, {:stop, self(), ref})

    receive do
      {:max_pause, ^ref, max_pause} -> max_pause
    after
      5_000 -> 0
    end
  end

  ## Helpers

  defp timed(fun) do
    started = now()
    result = fun.()
    {now() - started, result}
  end

  defp timed_each(items, fun) do
    {samples, results} =
      items
      |> Enum.map(fn item -> timed(fn -> fun.(item) end) end)
      |> Enum.unzip()

    {samples, results}
  end

  defp stats(samples) do
    sorted = Enum.sort(samples)

    %{
      n: length(sorted),
      p50: at(sorted, 0.50),
      p95: at(sorted, 0.95),
      p99: at(sorted, 0.99),
      max: List.last(sorted) || 0
    }
  end

  defp at([], _p), do: 0
  defp at(sorted, p), do: Enum.at(sorted, min(ceil(p * length(sorted)) - 1, length(sorted) - 1))

  defp fmt(value) when is_binary(value), do: value
  defp fmt(value), do: inspect(value)

  defp read_row(label, samples) do
    lat = stats(samples)
    [label, "#{lat.n}", us(lat.p50), us(lat.p95), us(lat.p99)]
  end

  defp us(ns), do: Float.round(ns / 1_000, 2) |> to_string()
  defp seconds(us), do: Float.round(us / 1_000_000, 3) |> to_string()
  defp kb(bytes), do: "#{round(bytes / 1024)}"
  defp rate(actions, elapsed_ns), do: "#{round(actions * 1.0e9 / max(elapsed_ns, 1))}"

  defp shape_name(:hot_content), do: "hot content (2 Updates, 1 row)"
  defp shape_name(:hot), do: "hot membership (2 Updates, 1 row)"
  defp shape_name(:spread), do: "spread (5 Updates, 2 rows)"

  defp shuffle(items), do: Enum.shuffle(items)

  defp vm_memory do
    %{total: :erlang.memory(:total), binary: :erlang.memory(:binary)}
  end

  defp gc do
    :erlang.garbage_collect()
    :erlang.garbage_collect()
  end

  defp now, do: System.monotonic_time(:nanosecond)

  defp host do
    case File.read("/proc/sys/kernel/hostname") do
      {:ok, name} -> String.trim(name)
      _ -> "unknown"
    end
  end

  defp build do
    case System.cmd("git", ["rev-parse", "--short", "HEAD"], stderr_to_stdout: true) do
      {sha, 0} -> String.trim(sha)
      _ -> "unknown"
    end
  end

  defp dirty? do
    case System.cmd("git", ["status", "--porcelain"], stderr_to_stdout: true) do
      {out, 0} -> String.trim(out) != ""
      _ -> false
    end
  end

  defp tmp_dir(tag) do
    Path.join(
      System.tmp_dir!(),
      "ebb_spike_844_c1_#{tag}_#{System.os_time(:second)}_#{System.unique_integer([:positive])}"
    )
  end
end
