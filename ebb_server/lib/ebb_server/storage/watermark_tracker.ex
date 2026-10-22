defmodule EbbServer.Storage.WatermarkTracker do
  @moduledoc """
  Owns the resolution-frontier state that gates SSE fan-out.

  ## What the watermark is

  The watermark is a **resolution frontier**: the highest GSN up to which
  every prior GSN is either committed to RocksDB or deliberately
  abandoned. After the Writer commits a batch it calls
  `mark_range_committed/3`; after it gives up on a claimed range it calls
  `mark_range_resolved/3`. Both insert the GSNs into the same ETS table,
  so the frontier advances across either.

  A watermark step therefore does not imply a durable Action at every
  GSN. Deliberately abandoned ranges leave permanent **holes** in the
  Action log. That is acceptable: the client outbox owns eventual
  durability, the server never acks undurable data, and GSNs are never
  rewound or reused. Density (no holes) is a convenience, not an
  invariant — liveness is.

  The frontier can cover a durable range whose live notification has not
  been sent yet: the Writer marks the range committed on the ack, while
  `EbbServer.Sync.FanOutRouter` is notified only after the ordered apply.
  That is safe because the Router pushes on the notification, not on the
  frontier; see `EbbServer.Storage.CommitPipeline`.

  SSE subscribers send `cursor=N` with `GET /sync/live`; the Fan-Out
  Router only forwards a batch to a subscriber once the resolution
  frontier has passed that batch's end. This makes per-subscriber
  ordering independent of how many writes happened in the meantime
  — a subscriber that disconnects for an hour and reconnects sees
  GSNs strictly in committed order, never skips a committed range,
  never receives a future GSN ahead of its own state.

  ## Data structures

  - `:persistent_term {WatermarkTracker, :gsn_ref}` — the `:atomics.atomics/0`
    reference holding the current committed watermark (one integer).
  - `:persistent_term {WatermarkTracker, :committed_ranges}` — the ETS
    table name holding one `{first_gsn, last_gsn}` row per **resolved
    range** (committed or abandoned). Rows are the reorder buffer only: a
    range that continues the frontier advances it and is deleted, so a
    normal writer keeps at most one row per in-flight range and usually
    none.

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

  - `:ets :committed_ranges` - ordered_set table, key is the range's first
    GSN, value is its last GSN

  The Writer's `EbbServer.Storage.CommitPipeline` owns which claimed range
  is committed or resolved and in what order; this module owns the global
  frontier that fan-out and restart recovery read.
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
  Returns the current resolution frontier (0 if never advanced).

  The name is kept for compatibility; see the moduledoc for why the
  value is a resolution frontier rather than a pure committed watermark.
  """
  @spec committed_watermark(GenServer.name()) :: gsn()
  def committed_watermark(name \\ __MODULE__) do
    gsn_ref = :persistent_term.get({name, :gsn_ref})
    :atomics.get(gsn_ref, 1)
  end

  @doc """
  Marks a range of GSNs as resolved.

  Resolved means committed *or* deliberately abandoned; the frontier
  advance cannot tell them apart by design. Use this for a range whose
  commit failed and will never be written.

  ## Examples

      iex> WatermarkTracker.mark_range_resolved(1, 5)
      :ok
  """
  @spec mark_range_resolved(gsn(), gsn(), GenServer.name()) :: :ok
  def mark_range_resolved(first, last, name \\ __MODULE__) do
    mark_range_committed(first, last, name)
  end

  @doc """
  Records a resolved range as one row. Does not advance the watermark.

  Call `advance_watermark/1` afterwards; that is what moves the frontier.
  One row per range is enough because the frontier moves a whole range at a
  time, and a range that cannot move it yet is only ever re-examined as a
  unit.

  ## Examples

      iex> WatermarkTracker.mark_range_committed(1, 5)
      :ok
  """
  @spec mark_range_committed(gsn(), gsn(), GenServer.name()) :: :ok
  def mark_range_committed(first, last, name \\ __MODULE__) when first <= last do
    table_name = :persistent_term.get({name, :committed_ranges})
    :ets.insert(table_name, {first, last})
    :ok
  end

  @doc """
  Advances the watermark to the highest GSN covered by a contiguous run of
  resolved ranges.

  Returns the new watermark value. If no advancement is possible (a gap in
  the sequence), returns the current watermark.

  Each step consumes a whole range, so a flush that resolves 100 GSNs costs
  one step, not 100.
  """
  @spec advance_watermark(GenServer.name()) :: gsn()
  def advance_watermark(name \\ __MODULE__) do
    gsn_ref = :persistent_term.get({name, :gsn_ref})
    table_name = :persistent_term.get({name, :committed_ranges})
    do_advance(gsn_ref, table_name)
  end

  defp do_advance(gsn_ref, table_name) do
    current = :atomics.get(gsn_ref, 1)
    prune_resolved(table_name, current)

    case range_covering(table_name, current + 1) do
      {_first, last} ->
        case :atomics.compare_exchange(gsn_ref, 1, current, last) do
          :ok ->
            # Absorb any further contiguous range, then drop the rows the
            # frontier just passed.
            do_advance(gsn_ref, table_name)

          _ ->
            # Another process advanced the frontier first; retry from its
            # value rather than reporting one we know is stale.
            do_advance(gsn_ref, table_name)
        end

      nil ->
        # A concurrent advance may have moved the frontier between the read
        # and the lookup; re-read rather than return a stale value.
        if :atomics.get(gsn_ref, 1) > current do
          do_advance(gsn_ref, table_name)
        else
          current
        end
    end
  end

  # The row covering `gsn`, if any: the largest first-GSN at or below it whose
  # range reaches it. `:ets.prev/2` makes this O(log n) instead of the scan a
  # partially-bound match over the key would do.
  defp range_covering(table_name, gsn) do
    case :ets.prev(table_name, gsn + 1) do
      :"$end_of_table" ->
        nil

      first when is_integer(first) ->
        case :ets.lookup(table_name, first) do
          [{^first, last}] when last >= gsn -> {first, last}
          _ -> nil
        end
    end
  end

  # Rows the frontier has passed are dead weight: `range_covering/2` only ever
  # looks at `watermark + 1` and beyond. Rows are per range, so this deletes a
  # handful of tuples, not one per GSN.
  defp prune_resolved(_table_name, watermark) when watermark <= 0, do: 0

  defp prune_resolved(table_name, watermark) do
    :ets.select_delete(table_name, [
      {{:"$1", :"$2"}, [{:"=<", :"$2", watermark}], [true]}
    ])
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
