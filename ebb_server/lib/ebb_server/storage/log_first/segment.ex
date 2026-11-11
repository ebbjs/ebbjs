defmodule EbbServer.Storage.LogFirst.Segment do
  @moduledoc """
  Spike-only owned segment file (#844, D1): append, CRC, torn-tail repair and a
  sparse GSN → offset index.

  A segment is a sequence of records, never rewritten:

      "E8S1" | kind::8 | gsn::64 | len::32 | crc32(body)::32 | body

  `gsn` is the record's position in the global order and is inside the hashed
  bytes, so a future verification layer's leaf is `hash(kind ‖ gsn ‖ body)`
  (I5). A record whose CRC, length or GSN order does not hold is a torn tail:
  `open/2` truncates at the last intact boundary and reports the repair, and a
  caller that was never acked retries. Nothing reads past a torn boundary.

  The index samples every `@index_stride`-th record's byte offset at open, so a
  GSN read starts from the nearest sample instead of the file head. It is a
  cache: the records are the source of truth and the index is rebuilt on open.

  Nothing here is wired into `Storage.Supervisor` or the default write path.
  """

  @magic "E8S1"
  @header byte_size(@magic) + 1 + 8 + 4 + 4
  @index_stride 64

  @typedoc """
  An open segment: the raw fd, the path, the next byte offset, the last GSN,
  and the sparse index (`[{gsn, offset}]`, ascending).
  """
  @type t :: %{
          fd: :file.fd(),
          path: String.t(),
          offset: non_neg_integer(),
          tail_gsn: non_neg_integer() | nil,
          index: [{pos_integer(), non_neg_integer()}],
          records: non_neg_integer()
        }

  @type record :: %{kind: atom(), gsn: pos_integer(), body: binary()}

  @doc """
  Record header size in bytes.
  """
  @spec header_size() :: pos_integer()
  def header_size, do: @header

  @doc """
  Opens (creating if absent) a segment and repairs a torn tail.

  Returns `{:ok, log, repairs}` where `repairs` lists what recovery discarded —
  `[]` for a clean segment. A repaired segment is truncated on disk, so the
  next append starts at a record boundary.
  """
  @spec open(Path.t()) :: {:ok, t(), [term()]}
  def open(path) do
    File.mkdir_p!(Path.dirname(path))

    {:ok, fd} = :file.open(path, [:raw, :binary, :read, :write])

    case scan(fd, 0, 0, nil, [], []) do
      {:ok, %{offset: offset} = state, repairs} ->
        {:ok, ^offset} = :file.position(fd, {:bof, offset})
        :ok = :file.truncate(fd)

        {:ok,
         %{
           fd: fd,
           path: path,
           offset: offset,
           tail_gsn: state.tail_gsn,
           index: state.index,
           records: state.records
         }, Enum.reverse(repairs)}
    end
  end

  @doc """
  Closes the segment.
  """
  @spec close(t()) :: :ok
  def close(%{fd: fd}) do
    :file.close(fd)
    :ok
  end

  @doc """
  Appends `records` as one write and, when `sync` is true, one `datasync`.

  The caller supplies the GSNs; the segment refuses a non-increasing GSN so a
  hole or a rewind is a write error rather than a silently unreadable tail.
  """
  @spec append(t(), [record()], boolean()) :: {:ok, t()} | {:error, term()}
  def append(%{} = log, records, sync \\ true) do
    with :ok <- check_order(log.tail_gsn, records) do
      {iodata, bytes, tail, index} = encode(log, records)

      case :file.pwrite(log.fd, log.offset, iodata) do
        :ok ->
          with :ok <- maybe_sync(log.fd, sync) do
            {:ok,
             %{
               log
               | offset: log.offset + bytes,
                 tail_gsn: tail,
                 index: index,
                 records: log.records + length(records)
             }}
          end

        {:error, reason} ->
          {:error, {:append, reason}}
      end
    end
  end

  @doc """
  The last GSN in the segment, or `nil` for an empty one.
  """
  @spec tail(t()) :: non_neg_integer() | nil
  def tail(%{tail_gsn: tail}), do: tail

  @doc """
  Reads the record at `gsn`, or `:not_found`.

  The sparse index picks the nearest sample at or before `gsn`, then the
  read walks forward. A GSN below the first sample starts at the file head.
  """
  @spec read(t(), pos_integer()) :: {:ok, record()} | :not_found | {:error, term()}
  def read(%{} = log, gsn) do
    case start_offset(log.index, gsn) do
      {:ok, offset} -> scan_for(log.fd, offset, gsn, log.offset)
      {:error, reason} -> {:error, reason}
    end
  end

  @doc """
  Reads every record in `from..to`, ascending, stopping at the first absent
  GSN. A catch-up page is this call with a bounded range.
  """
  @spec read_range(t(), pos_integer(), pos_integer()) :: {:ok, [record()]} | {:error, term()}
  def read_range(%{} = log, from, to) when from <= to do
    {records, _next} = walk(log.fd, from, to, start_offset!(log.index, from), log.offset, [])
    {:ok, Enum.reverse(records)}
  end

  @doc """
  Rebuilds the sparse index and tail by scanning the file, without holding an
  open segment. Used by the property test and by a reader that only wants a
  summary.
  """
  @spec inspect_file(Path.t()) :: {:ok, map()} | {:error, term()}
  def inspect_file(path) do
    case :file.open(path, [:read, :raw, :binary]) do
      {:ok, fd} ->
        try do
          {:ok, state, repairs} = scan(fd, 0, 0, nil, [], [])
          {:ok, Map.put(state, :repairs, Enum.reverse(repairs))}
        after
          :file.close(fd)
        end

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp scan(fd, offset, count, tail_gsn, index, repairs) do
    case :file.pread(fd, offset, @header) do
      {:ok, <<@magic, _kind, gsn::unsigned-64, len::unsigned-32, crc::unsigned-32>>} ->
        case :file.pread(fd, offset + @header, len) do
          {:ok, body} when byte_size(body) == len ->
            cond do
              :erlang.crc32(body) != crc ->
                {:ok, %{offset: offset, tail_gsn: tail_gsn, index: index, records: count},
                 [:crc | repairs]}

              tail_gsn != nil and gsn <= tail_gsn ->
                {:ok, %{offset: offset, tail_gsn: tail_gsn, index: index, records: count},
                 [{:gsn_order, gsn, tail_gsn} | repairs]}

              true ->
                index =
                  if rem(count, @index_stride) == 0,
                    do: index ++ [{gsn, offset}],
                    else: index

                scan(fd, offset + @header + len, count + 1, gsn, index, repairs)
            end

          _short ->
            {:ok, %{offset: offset, tail_gsn: tail_gsn, index: index, records: count},
             [:short_body | repairs]}
        end

      {:ok, _unknown} ->
        {:ok, %{offset: offset, tail_gsn: tail_gsn, index: index, records: count},
         [:bad_header | repairs]}

      :eof ->
        {:ok, %{offset: offset, tail_gsn: tail_gsn, index: index, records: count}, repairs}

      {:error, reason} ->
        {:ok, %{offset: offset, tail_gsn: tail_gsn, index: index, records: count},
         [{:pread, reason} | repairs]}
    end
  end

  defp encode(log, records) do
    {iodata, bytes, tail, index} =
      records
      |> Enum.with_index()
      |> Enum.reduce({[], 0, log.tail_gsn, log.index}, fn {record, position},
                                                          {acc, bytes, _tail, index} ->
        header =
          <<@magic, kind_byte(record.kind), record.gsn::unsigned-64,
            byte_size(record.body)::unsigned-32, :erlang.crc32(record.body)::unsigned-32>>

        index =
          if rem(log.records + position, @index_stride) == 0,
            do: index ++ [{record.gsn, log.offset + bytes}],
            else: index

        {[acc, header, record.body], bytes + @header + byte_size(record.body), record.gsn, index}
      end)

    {iodata, bytes, tail, index}
  end

  defp check_order(_tail, []), do: :ok

  defp check_order(tail, [first | rest]) do
    cond do
      tail != nil and first.gsn <= tail -> {:error, {:gsn_not_after_tail, first.gsn, tail}}
      true -> check_order_from(first.gsn, rest)
    end
  end

  defp check_order_from(_previous, []), do: :ok

  defp check_order_from(previous, [record | rest]) do
    if record.gsn <= previous,
      do: {:error, {:gsn_not_ascending, record.gsn, previous}},
      else: check_order_from(record.gsn, rest)
  end

  defp maybe_sync(_fd, false), do: :ok
  defp maybe_sync(fd, true), do: :file.datasync(fd)

  defp start_offset!(index, gsn) do
    {:ok, offset} = start_offset(index, gsn)
    offset
  end

  defp start_offset(index, gsn) do
    sample =
      index
      |> Enum.take_while(fn {sample_gsn, _offset} -> sample_gsn <= gsn end)
      |> List.last()

    {:ok, if(sample, do: elem(sample, 1), else: 0)}
  end

  defp scan_for(_fd, start, _gsn, limit) when is_integer(start) and start >= limit,
    do: :not_found

  defp scan_for(fd, start, gsn, limit) do
    case read_at(fd, start) do
      {:ok, record, next} when record.gsn < gsn -> scan_for(fd, next, gsn, limit)
      {:ok, record, _next} when record.gsn == gsn -> {:ok, record}
      {:ok, _record, _next} -> :not_found
      :eof -> :not_found
      {:error, reason} -> {:error, reason}
    end
  end

  defp walk(_fd, from, to, _start, _limit, acc) when from > to, do: {acc, from}

  defp walk(fd, from, to, start, limit, acc) do
    case scan_from(fd, start || 0, from, limit) do
      {:ok, record, next} -> walk(fd, record.gsn + 1, to, next, limit, [record | acc])
      :not_found -> {acc, from}
    end
  end

  defp scan_from(_fd, start, _gsn, limit) when start >= limit, do: :not_found

  defp scan_from(fd, start, gsn, limit) do
    case read_at(fd, start) do
      {:ok, record, next} when record.gsn < gsn -> scan_from(fd, next, gsn, limit)
      {:ok, record, next} when record.gsn == gsn -> {:ok, record, next}
      _ -> :not_found
    end
  end

  defp read_at(fd, offset) do
    case :file.pread(fd, offset, @header) do
      {:ok, <<@magic, kind, gsn::unsigned-64, len::unsigned-32, crc::unsigned-32>>} ->
        case :file.pread(fd, offset + @header, len) do
          {:ok, body} when byte_size(body) == len ->
            if :erlang.crc32(body) == crc,
              do: {:ok, %{kind: kind_atom(kind), gsn: gsn, body: body}, offset + @header + len},
              else: {:error, {:crc, gsn}}

          _ ->
            :eof
        end

      {:ok, _unknown} ->
        :eof

      :eof ->
        :eof

      {:error, reason} ->
        {:error, reason}
    end
  end

  @kinds %{action_batch: 1, reject: 2, duplicate: 3, snapshot_done: 4}

  @doc """
  The record kinds the segment format carries.
  """
  def kinds, do: Map.keys(@kinds)

  defp kind_byte(kind), do: Map.fetch!(@kinds, kind)
  defp kind_atom(byte), do: @kinds |> Map.new(fn {k, v} -> {v, k} end) |> Map.fetch!(byte)
end
