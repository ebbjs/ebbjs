defmodule EbbServer.Bench.DiskLogAppend do
  @moduledoc """
  Bench-only `disk_log` append — the OTP contender `t5 --engine disk_log`
  prices against the owned-segment arms (#844, D3b).

  The sample covers exactly what `EbbServer.Bench.LogAppend`'s `log_first`
  engine covers: `LogAppend.window_record/4` builds one 100-Action window
  record (the same `ActionFormat` frames the production flush stores in
  `cf_actions`), then one `:disk_log.balog/2` and one `:disk_log.sync/1`
  make it durable. Nothing here is wired into the write path.

  ## What `disk_log` adds to the bytes on disk

  A halt log with `format: external` and no `head` writes **no framing of
  its own**: `balog/2` hands the binary to `disk_log_1:logl/3`, which for
  external format returns the bytes unchanged, and `ext_log_head/2` with
  `head: none` writes no file header. The file is therefore exactly the
  concatenation of the window records — one window header per call, zero
  `disk_log` bytes. `:disk_log.chunk/3` cannot read such a file back at all
  (`{:error, {:format_external, Log}}`); an external log is a byte sink, so
  record framing and torn-tail detection stay the caller's job (see
  `recovery/1`).

  ## Why every append extends the file

  `disk_log` preallocates nothing for a halt log: `{size, N}` is only an
  upper bound that ends the log with `{error, {full, Log}}`, and a new file
  is opened at EOF with no `file:position/truncate` reservation. So each
  append lands past EOF, allocates blocks and moves `i_size`, which is the
  ext4 metadata path the D3 64 KB probe priced at ~1,080 µs rather than the
  ~337 µs in-place path the recycled segment reaches. There is no `disk_log`
  option that changes this; only a wrap log reuses blocks, and it overwrites
  the records it reuses.

  ## Process model

  The log lives in `disk_log`'s own process. `balog/2` is a cast, so the
  caller returns as soon as the message is sent and the write happens
  remotely; `sync/1` is a call that flushes that process's 64 KB write cache
  with `file:sync/1` (fsync, not `datasync`) and also orders every earlier
  cast from the same caller. `--durability async` therefore prices the
  enqueue only, not an append — unlike `log_first`, whose async arm still
  issues the `pwrite`. Records larger than the cache (b1000 is ~510 KB)
  are written by `balog/2` itself, so the async arm starts to include the
  write at that window size.

  Each caller owns one log file under the system temp directory, opened at
  its first sample and closed by `close/0` when the caller's run ends. The
  files are left in place, like the owned-segment arm's, so a pass can be
  inspected afterwards.
  """

  alias EbbServer.Bench.{LogAppend, Options}

  @dir "ebb_spike_844_d3_disk_log"
  @magic "E844"
  @header byte_size(@magic) + 1 + 4 + 4 + 4

  @type state :: %{
          log: :disk_log.log(),
          path: String.t(),
          records: non_neg_integer(),
          bytes: non_neg_integer()
        }

  @doc """
  Runs one sample and returns `{:ok, latency_us, bytes}` or
  `{:error, latency_us, reason}`.

  The latency spans the window record build (the same one `log_first`
  charges), one `:disk_log.balog/2` and, unless `--durability async`, one
  `:disk_log.sync/1`.
  """
  @spec perform(Options.t(), map(), non_neg_integer(), non_neg_integer()) ::
          {:ok, non_neg_integer(), non_neg_integer()}
          | {:error, non_neg_integer(), term()}
  def perform(%Options{} = config, ctx, caller_id, seq) do
    state = state(caller_id)
    started = now()

    record = LogAppend.window_record(config, ctx, caller_id, seq)

    with :ok <- :disk_log.balog(state.log, record),
         :ok <- sync(config, state.log) do
      advance(state, byte_size(record))
      {:ok, elapsed(started), byte_size(record)}
    else
      {:error, reason} -> {:error, elapsed(started), reason}
    end
  end

  @doc """
  Closes the log this caller opened, so a finished run leaves a closed file
  rather than one whose descriptor dies with the worker process.

  A no-op for a caller that never sampled — every tier but `t5 --engine
  disk_log` can call it unconditionally.
  """
  @spec close() :: :ok | {:error, term()}
  def close do
    case Process.delete(key()) do
      nil ->
        :ok

      %{log: log} ->
        :disk_log.close(log)
    end
  end

  @doc """
  The directory this engine writes its per-caller log files to.
  """
  @spec dir() :: String.t()
  def dir, do: Path.join(System.tmp_dir!(), @dir)

  @doc """
  The log file this caller is appending to, or `nil` before its first sample.
  """
  @spec current_path() :: String.t() | nil
  def current_path do
    case Process.get(key()) do
      nil -> nil
      %{path: path} -> path
    end
  end

  @doc """
  Reads a log file back as window records.

  `disk_log` cannot read an external-format log (`chunk/3` returns
  `{:error, {:format_external, Log}}`) and its `repair: true` only rewrites
  *internal* logs, so recovery has to be driven from the record format. This
  walks the window headers and returns the intact prefix plus, when the file
  does not end on a record boundary, what stopped the walk:

    * `error: nil` — every byte parsed as a complete, CRC-valid record;
    * `error: {:torn_tail, offset, bytes}` — `bytes` remain at `offset`, fewer
      than the window header or its payload, so the last record was cut
      mid-write. Every record before `offset` is intact.
    * `error: {:bad_record, offset, reason}` — a complete header that does not
      start with the record magic, or a payload whose CRC does not match.
  """
  @spec recovery(Path.t()) :: %{
          records: [map()],
          bytes: non_neg_integer(),
          error:
            nil
            | {:torn_tail, non_neg_integer(), non_neg_integer()}
            | {:bad_record, non_neg_integer(), term()}
        }
  def recovery(path) do
    walk(File.read!(path), 0, %{records: [], bytes: 0, error: nil})
  end

  defp walk(<<>>, _offset, acc), do: finish(acc)

  # Anything shorter than a window header cannot be a record; that is a torn
  # tail, not a corrupt one.
  defp walk(rest, offset, acc) when byte_size(rest) < @header,
    do: finish(acc, {:torn_tail, offset, byte_size(rest)})

  defp walk(rest, offset, acc) do
    case rest do
      <<@magic, _::binary>> -> walk_window(rest, offset, acc)
      _ -> finish(acc, {:bad_record, offset, :window_header})
    end
  end

  defp walk_window(
         <<@magic, version::unsigned-8, count::unsigned-32, len::unsigned-32, crc::unsigned-32,
           payload::binary-size(len), tail::binary>>,
         offset,
         acc
       ) do
    if :erlang.crc32(payload) == crc do
      record = %{offset: offset, version: version, count: count, bytes: @header + len}
      walk(tail, offset + @header + len, %{acc | records: [record | acc.records]})
    else
      finish(acc, {:bad_record, offset, :window_crc})
    end
  end

  # The magic is there but the header or the payload it declares is not: the
  # record was cut mid-write.
  defp walk_window(rest, offset, acc), do: finish(acc, {:torn_tail, offset, byte_size(rest)})

  defp finish(acc, error \\ nil) do
    records = Enum.reverse(acc.records)
    %{acc | records: records, bytes: Enum.reduce(records, 0, &(&1.bytes + &2)), error: error}
  end

  defp state(caller_id) do
    case Process.get(key()) do
      nil ->
        File.mkdir_p!(dir())
        path = log_path(caller_id)

        {:ok, log} =
          :disk_log.open(
            name: log_name(caller_id),
            file: String.to_charlist(path),
            type: :halt,
            format: :external,
            repair: true
          )

        state = %{log: log, path: path, records: 0, bytes: 0}
        Process.put(key(), state)
        state

      state ->
        state
    end
  end

  defp advance(state, bytes) do
    Process.put(key(), %{
      state
      | records: state.records + 1,
        bytes: state.bytes + bytes
    })
  end

  # One caller process opens one log per pass, so the process dictionary is
  # the whole state; `close/0` pops it.
  defp key, do: __MODULE__

  defp log_name(caller_id) do
    :"ebb_spike_844_d3_#{caller_id}_#{System.unique_integer([:positive])}"
  end

  defp log_path(caller_id) do
    Path.join(
      dir(),
      "dlog-#{System.os_time(:second)}-#{System.unique_integer([:positive])}-#{caller_id}.log"
    )
  end

  defp sync(%Options{durability: :sync}, log), do: :disk_log.sync(log)
  defp sync(_config, _log), do: :ok

  defp now, do: System.monotonic_time(:microsecond)

  defp elapsed(started), do: now() - started
end
