defmodule EbbServer.Storage.WatermarkTracker do
  @moduledoc """
  Owns the committed-watermark state that gates SSE fan-out.

  ## What the watermark is

  After the Writer commits a batch of Actions to RocksDB, it calls
  `mark_range_committed/2` with the GSN range it just landed. The
  watermark is the GSN up to which all prior GSNs are durable.

  SSE subscribers send `cursor=N` with `GET /sync/live`; the Fan-Out
  Router only forwards a batch to a subscriber once the committed
  watermark has passed that batch's end. This makes per-subscriber
  ordering independent of how many writes happened in the meantime
  — a subscriber that disconnects for an hour and reconnects sees
  GSNs strictly in committed order, never skips a range, never receives
  a future GSN ahead of its own state.

  ## Data structures

  - `:persistent_term {WatermarkTracker, :gsn_ref}` — the `:atomics.atomics/0`
    reference holding the current committed watermark (one integer).
  - `:persistent_term {WatermarkTracker, :committed_ranges}` — the ETS
    table name holding `{gsn, pid}` pairs for in-flight writers (used
    to skip the work of the same Writer catching up its own batches).

  ## Lifecycle

  The GenServer exists only to own the ETS table and `:atomics`
  reference lifetimes and to manage startup/shutdown. **All public
  functions are lock-free** — ETS reads, ETS writes, and `:atomics`
  operations. No `GenServer.call` is ever made on the write path; the
  single Writer (`EbbServer.Storage.Writer`) and `FanOutRouter` call
  these functions directly from any process.

  ## Why ETS, not a GenServer

  Every committed batch triggers a watermark advance, and every SSE
  subscriber's catch-up cursor comparison needs to read it. Routing
  every read through a GenServer mailbox would put that load on the
  Writer's mailbox. ETS + `:atomics` keeps the read path zero-copy and
  avoids serializing through a single process for what should be
  scalable hot-path state.

  - `:ets :committed_ranges` - ordered_set table, key is {gsn, pid}, value is true
  """

  use GenServer

  alias EbbServer.Storage.RocksDB

  @default_committed_ranges_name :committed_ranges

  @type gsn :: non_neg_integer()

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, opts, name: name)
  end

  @doc """
  Returns the current committed watermark (0 if never advanced).
  """
  @spec committed_watermark(GenServer.name()) :: gsn()
  def committed_watermark(name \\ __MODULE__) do
    gsn_ref = :persistent_term.get({name, :gsn_ref})
    :atomics.get(gsn_ref, 1)
  end

  @doc """
  Marks a range of GSNs as committed (inserts into ETS, does not advance watermark).

  ## Examples

      iex> WatermarkTracker.mark_range_committed(1, 5)
      :ok
  """
  @spec mark_range_committed(gsn(), gsn(), GenServer.name()) :: :ok
  def mark_range_committed(first, last, name \\ __MODULE__) when first <= last do
    table_name = :persistent_term.get({name, :committed_ranges})
    pid = self()

    entries = for gsn <- first..last, do: {{gsn, pid}, true}
    :ets.insert(table_name, entries)

    :ok
  end

  @doc """
  Advances the watermark to the highest contiguous GSN in the committed ranges table.

  Returns the new watermark value. If no advancement is possible (gap in sequence),
  returns the current watermark.
  """
  @spec advance_watermark(GenServer.name()) :: gsn()
  def advance_watermark(name \\ __MODULE__) do
    gsn_ref = :persistent_term.get({name, :gsn_ref})
    table_name = :persistent_term.get({name, :committed_ranges})
    do_advance_loop(gsn_ref, table_name)
  end

  defp do_advance_loop(gsn_ref, table_name) do
    current_watermark = :atomics.get(gsn_ref, 1)
    next_gsn = current_watermark + 1

    if has_committed?(table_name, next_gsn) do
      attempt_advance_from(gsn_ref, table_name, current_watermark, next_gsn)
    else
      current_watermark
    end
  end

  # Has any tuple {gsn, _pid} with this gsn been committed?
  defp has_committed?(table_name, gsn) do
    :ets.match_object(table_name, {{gsn, :_}, true}) != []
  end

  # We've confirmed `gsn` is committed. Try to CAS the watermark from
  # `prev` to `gsn`; on contention, retry the whole loop (the other writer
  # may have advanced past us, in which case we'll try to advance further
  # from the new value). On success, recurse to see if `gsn + 1` is also
  # committed and continue advancing.
  defp attempt_advance_from(gsn_ref, table_name, prev, gsn) do
    case :atomics.compare_exchange(gsn_ref, 1, prev, gsn) do
      :ok ->
        if has_committed?(table_name, gsn + 1) do
          attempt_advance_from(gsn_ref, table_name, gsn, gsn + 1)
        else
          gsn
        end

      _ ->
        do_advance_loop(gsn_ref, table_name)
    end
  end

  @impl true
  def init(opts) do
    name = Keyword.get(opts, :name, __MODULE__)
    table_name = Keyword.get(opts, :table, @default_committed_ranges_name)

    gsn_ref =
      case Keyword.get(opts, :initial_gsn) do
        nil ->
          ref = :atomics.new(1, signed: false)
          seed_watermark_from_rocksdb(ref)
          ref

        initial_gsn ->
          ref = :atomics.new(1, signed: false)
          :atomics.put(ref, 1, initial_gsn)
          ref
      end

    :persistent_term.put({name, :gsn_ref}, gsn_ref)
    :persistent_term.put({name, :committed_ranges}, table_name)
    :ets.new(table_name, [:ordered_set, :public, :named_table])

    {:ok, %{name: name, table: table_name, gsn_ref: gsn_ref}}
  end

  defp seed_watermark_from_gsn(ref, gsn) do
    if gsn > 0 do
      :atomics.put(ref, 1, gsn)
    end
  end

  defp seed_watermark_from_rocksdb(ref) do
    max_gsn = RocksDB.get_max_gsn()
    seed_watermark_from_gsn(ref, max_gsn)
  end

  @impl true
  def terminate(_reason, state) do
    try do
      :ets.delete(state.table)
    rescue
      ArgumentError -> :ok
    end

    :ok
  end
end
