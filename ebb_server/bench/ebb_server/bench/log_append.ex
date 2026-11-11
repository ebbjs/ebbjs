defmodule EbbServer.Bench.LogAppend do
  @moduledoc """
  Bench-only owned-segment append — the contender `t5 --engine log_first` prices
  against the production `write_batch` (#844, D3).

  The record built here holds the same bytes the production flush stores in
  `cf_actions`: each Action is an `ActionFormat` frame (payload ETF plus the
  per-Update scope snapshot), length-prefixed and GSN-stamped. A window record
  is the concatenation of those frames behind one count, one length and one
  CRC, appended with a single `:file.pwrite/3` and a single `:file.datasync/1`.

  Nothing here is wired into the write path: no Writer, no cache mutation, no
  watermark, no fan-out. Callers own disjoint GSN ranges and their own segment
  file, exactly as `EbbServer.Bench.WriteBatch` owns a disjoint GSN space.

  The segment is preallocated once per pass and appended at a tracked offset,
  so a sample prices the append and not the file's metadata growth. The
  `log_first_io` engine appends a prebuilt record instead, which is the pure
  syscall + flush floor; `log_first_assemble` builds the record and writes
  nothing. The three engines exist so a delta can be attributed to assembly,
  to the syscall, or to the flush rather than reported as "faster".
  """

  alias EbbServer.Bench.{Options, Workbook}
  alias EbbServer.Storage.{ActionFormat, ActionValidator}

  # Windows are appended from offset 0. The sparse preallocation keeps ext4
  # from extending the file's metadata in the measured region; the written
  # extents are allocated by the writes themselves, as an appender's would be.
  @preallocate_bytes 32 * 1024 * 1024 * 1024
  # Enough for a 20 s window at the fastest arm measured (~300 MB).
  @zeroed_bytes 512 * 1024 * 1024
  @segment_dir "ebb_spike_844_d3"
  @magic "E844"
  @version 1
  @window_header byte_size(@magic) + 1 + 4 + 4 + 4

  @type state :: %{
          fd: :file.fd(),
          path: String.t(),
          offset: non_neg_integer(),
          records: non_neg_integer(),
          bytes: non_neg_integer(),
          prebuilt: binary() | nil
        }

  @doc """
  Runs one sample and returns `{:ok, latency_us, bytes}` or
  `{:error, latency_us, reason}`.

  `log_first` times frame assembly, the CRC, the one `pwrite` and the one
  `datasync`; `log_first_assemble` stops before the write; `log_first_io`
  writes a record built once per pass, so it prices the syscall and the flush
  alone. `--durability async` drops the `datasync` for every engine.
  """
  @spec perform(Options.t(), map(), non_neg_integer(), non_neg_integer()) ::
          {:ok, non_neg_integer(), non_neg_integer()}
          | {:error, non_neg_integer(), term()}
  def perform(%Options{engine: :log_first} = config, ctx, caller_id, seq) do
    state = state(config, ctx, caller_id)
    started = now()

    record = window_record(config, ctx, caller_id, seq)

    with :ok <- :file.pwrite(state.fd, state.offset, record),
         :ok <- datasync(config, state.fd) do
      advance(config, caller_id, state, byte_size(record))
      {:ok, elapsed(started), byte_size(record)}
    else
      {:error, reason} -> {:error, elapsed(started), reason}
    end
  end

  # The production-shaped variant: the segment's blocks are allocated and
  # written once before the measured window, so every append lands inside
  # already-written space and neither allocates blocks nor moves `i_size`.
  # The 64 KB probe on this host prices that at 337 µs against 811 µs for a
  # sparse write and 1,080 µs for an append past EOF.
  def perform(%Options{engine: :log_first_recycled} = config, ctx, caller_id, seq) do
    state = state(config, ctx, caller_id)
    started = now()

    record = window_record(config, ctx, caller_id, seq)

    with :ok <- :file.pwrite(state.fd, state.offset, record),
         :ok <- datasync(config, state.fd) do
      advance(config, caller_id, state, byte_size(record))
      {:ok, elapsed(started), byte_size(record)}
    else
      {:error, reason} -> {:error, elapsed(started), reason}
    end
  end

  def perform(%Options{engine: :log_first_assemble} = config, ctx, caller_id, seq) do
    started = now()
    record = window_record(config, ctx, caller_id, seq)
    {:ok, elapsed(started), byte_size(record)}
  end

  def perform(%Options{engine: :log_first_io} = config, ctx, caller_id, _seq) do
    state = state(config, ctx, caller_id)
    started = now()

    with :ok <- :file.pwrite(state.fd, state.offset, state.prebuilt),
         :ok <- datasync(config, state.fd) do
      advance(config, caller_id, state, byte_size(state.prebuilt))
      {:ok, elapsed(started), byte_size(state.prebuilt)}
    else
      {:error, reason} -> {:error, elapsed(started), reason}
    end
  end

  @doc """
  One window record: `magic | version | count | length | crc32(payload) | payload`,
  where each payload frame is `gsn::64 | length::32 | crc32(value) | value`.
  """
  @spec window_record(Options.t(), map(), non_neg_integer(), non_neg_integer()) :: binary()
  def window_record(%Options{} = config, ctx, caller_id, seq) do
    base = EbbServer.Bench.WriteBatch.gsn_start(caller_id, seq)

    payload =
      0..(config.batch_size - 1)
      |> Enum.map(fn offset ->
        gsn = base + offset
        value = stored_value(config, ctx, caller_id, seq + offset)

        <<gsn::unsigned-64, byte_size(value)::unsigned-32, :erlang.crc32(value)::unsigned-32,
          value::binary>>
      end)
      |> IO.iodata_to_binary()

    <<@magic, @version::unsigned-8, config.batch_size::unsigned-32,
      byte_size(payload)::unsigned-32, :erlang.crc32(payload)::unsigned-32, payload::binary>>
  end

  @doc """
  The exact `cf_actions` value the production flush would store for this
  Action, so the log's frames are the same bytes the batch arm writes.
  """
  @spec stored_value(Options.t(), map(), non_neg_integer(), non_neg_integer()) :: binary()
  def stored_value(%Options{} = config, ctx, caller_id, seq) do
    action =
      config
      |> Workbook.build_action(ctx, caller_id, seq)
      |> ActionValidator.to_validated_action()

    stored_value(action)
  end

  @doc """
  The stored value for an Action already built once.

  Building an Action is not reproducible (its ids come from the workbook), so
  the byte-identity test has to hand the same Action to both the batch and the
  log rather than rebuilding it twice.
  """
  @spec stored_value(map()) :: binary()
  def stored_value(action) do
    update_scopes = Enum.map(action.updates, fn _ -> [Workbook.group_id()] end)
    payload = action |> ActionFormat.build() |> ActionFormat.encode()

    ActionFormat.frame(payload, update_scopes)
  end

  @doc """
  The header size of a window record, for bytes-per-Action arithmetic.
  """
  def window_header, do: @window_header

  @doc """
  The per-frame overhead over the stored `cf_actions` value: 8 GSN + 4 length
  + 4 CRC bytes.
  """
  def frame_overhead, do: 16

  @doc """
  Verifies every segment in the run directory and returns one summary per
  file: window count, frame count, bytes, and any CRC/GSN/monotonicity error.
  """
  @spec verify_all(keyword()) :: [map()]
  def verify_all(opts \\ []) do
    since = Keyword.get(opts, :since, 0)

    dir()
    |> Path.join("*")
    |> Path.wildcard()
    |> Enum.filter(fn path ->
      case File.stat(path, time: :posix) do
        {:ok, %{mtime: mtime}} -> mtime >= since
        _ -> false
      end
    end)
    |> Enum.map(&verify/1)
  end

  @spec verify(Path.t()) :: map()
  def verify(path) do
    {:ok, fd} = :file.open(path, [:read, :raw, :binary])

    try do
      walk(fd, 0, nil, %{path: path, windows: 0, frames: 0, bytes: 0, errors: []})
    after
      :file.close(fd)
    end
  rescue
    error ->
      %{path: path, windows: 0, frames: 0, bytes: 0, errors: [{:open, Exception.message(error)}]}
  end

  defp walk(fd, offset, last, acc) do
    case :file.pread(fd, offset, @window_header) do
      {:ok, <<@magic, @version, count::unsigned-32, len::unsigned-32, crc::unsigned-32>>} ->
        case :file.pread(fd, offset + @window_header, len) do
          {:ok, payload} when byte_size(payload) == len ->
            if :erlang.crc32(payload) == crc do
              case frames(payload, count, last, []) do
                {:ok, frames_seen, last} ->
                  walk(fd, offset + @window_header + len, last, %{
                    acc
                    | windows: acc.windows + 1,
                      frames: acc.frames + frames_seen,
                      bytes: offset + @window_header + len
                  })

                {:error, error} ->
                  %{acc | errors: [error | acc.errors], bytes: offset}
              end
            else
              %{acc | errors: [:window_crc | acc.errors], bytes: offset}
            end

          _ ->
            %{acc | errors: [:short_window | acc.errors], bytes: offset}
        end

      # A preallocated tail reads as zeros. It is untouched space, not a torn
      # record, so the walk ends cleanly there.
      {:ok, _zero_tail} ->
        acc

      :eof ->
        acc

      {:error, reason} ->
        %{acc | errors: [{:pread, reason} | acc.errors]}
    end
  end

  defp frames(<<>>, 0, last, seen), do: {:ok, length(seen), last}

  defp frames(
         <<gsn::unsigned-64, len::unsigned-32, crc::unsigned-32, value::binary-size(len),
           rest::binary>>,
         count,
         last,
         seen
       ) do
    cond do
      last != nil and gsn <= last -> {:error, {:gsn_not_monotonic, gsn, last}}
      :erlang.crc32(value) != crc -> {:error, {:frame_crc, gsn}}
      true -> frames(rest, count - 1, gsn, [gsn | seen])
    end
  end

  defp frames(_rest, _count, _last, _seen), do: {:error, :frame_header}

  # One state per (pass, caller). A pass boots fresh storage, so the segment
  # file is truncated and preallocated at first use.
  defp state(%Options{} = config, ctx, caller_id) do
    key = {__MODULE__, config.port, caller_id}

    case Process.get(key) do
      nil ->
        path = segment_path(caller_id)
        File.mkdir_p!(dir())

        {:ok, fd} = :file.open(path, [:raw, :binary, :read, :write])
        {:ok, _} = :file.position(fd, {:bof, @preallocate_bytes})
        :ok = :file.truncate(fd)

        :ok =
          if config.engine == :log_first_recycled,
            do: zero_fill(fd, zeroed_bytes(config)),
            else: :ok

        prebuilt =
          if config.engine == :log_first_io,
            do: window_record(config, ctx, caller_id, 0),
            else: nil

        state = %{fd: fd, path: path, offset: 0, records: 0, bytes: 0, prebuilt: prebuilt}
        Process.put(key, state)
        state

      state ->
        state
    end
  end

  defp advance(%Options{} = config, caller_id, state, bytes) do
    Process.put({__MODULE__, config.port, caller_id}, %{
      state
      | offset: state.offset + bytes,
        records: state.records + 1,
        bytes: state.bytes + bytes
    })
  end

  # Written once per pass, before the window: it makes every later append an
  # in-place write instead of an allocation plus size extension.
  defp zero_fill(fd, zeroed_bytes) do
    zeros = :binary.copy(<<0>>, 1024 * 1024)

    for i <- 0..(div(zeroed_bytes, byte_size(zeros)) - 1) do
      :ok = :file.pwrite(fd, i * byte_size(zeros), zeros)
    end

    :file.datasync(fd)
  end

  # Each caller gets its own file, so the zeroing budget is shared across the
  # run: a fixed total keeps a c=8 pass from writing eight times the bytes.
  defp zeroed_bytes(%Options{concurrency: concurrency}) do
    max(div(@zeroed_bytes, max(concurrency, 1)), 64 * 1024 * 1024)
  end

  defp dir, do: Path.join(System.tmp_dir!(), @segment_dir)

  defp segment_path(caller_id) do
    Path.join(
      dir(),
      "seg-#{System.os_time(:second)}-#{System.unique_integer([:positive])}-#{caller_id}.seg"
    )
  end

  defp datasync(%Options{durability: :sync}, fd), do: :file.datasync(fd)
  defp datasync(_config, _fd), do: :ok

  defp now, do: System.monotonic_time(:microsecond)

  defp elapsed(started), do: now() - started
end
