defmodule EbbServer.Storage.InFlightActions do
  @moduledoc """
  Owns the set of Action ids that currently have a claim on a GSN but are
  not yet durable.

  ## Why it exists

  `EbbServer.Storage.Writer.plan/2` drops an Action whose id already
  appears in `cf_action_dedup`, the durable commit marker. That is enough
  while exactly one batch is in flight. Once multiple prepared batches can
  be committed concurrently, a retry can be planned *before* its first
  copy has committed: the durable marker does not exist yet, so both
  copies claim a GSN and the log records the same Action twice. This set
  closes that window — an Action id is planned only when it is neither
  committed nor in flight.

  The durable marker stays the source of truth. This set is a **concurrency
  guard only**: it holds ids for the handful of batches between the claim
  and the durable write, so it is bounded by the pipeline depth rather than
  by history. `cf_action_dedup` still grows without bound, and compacting
  it is out of scope ([#123](https://github.com/ebbjs/ebbjs/issues/123)).

  ## Data structures

  - `:persistent_term {InFlightActions, :table}` — the public named ETS
    `:set` of action ids. `:named_table` plus `:public` lets every process
    insert, delete, and count without a `GenServer.call`.

  The Writer's `EbbServer.Storage.CommitPipeline` owns the claim/release
  decision and its ordered view of the ids; this table is the lock-free
  projection that makes the claim atomic across processes.

  ## Lifecycle

  The GenServer exists only to own the ETS table lifetime. **All public
  functions are lock-free** — plain ETS operations, no `GenServer.call` on
  any write path — so the Writer pays one ETS write per Action and never
  queues behind this process.

  `clear/1` is only correct on Writer boot: at startup no commit is in
  flight, so any surviving id is stale. A Writer-only crash leaves its ids
  behind (the linked `EbbServer.Storage.Committer` dies with it), and the
  replacement Writer clears them in `init/1`. Every other path releases
  the ids it claimed — on the durable commit and on every abandon path —
  so the set is empty whenever no batch is in flight.

  ## Single Writer assumption

  The set assumes one Writer claims and releases ids. `release/2` cannot
  tell two claimants of the same id apart: if two Writers claimed the same
  id, the first to release would reopen it for the second to claim again.
  That cannot happen today because `plan/2` claims atomically with
  `:ets.insert_new/2` and only one Writer plans; multi-Writer ownership is
  [#287](https://github.com/ebbjs/ebbjs/issues/287).
  """

  use GenServer

  @default_table :ebb_inflight_action_ids

  @type id :: String.t()

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, opts, name: name)
  end

  @doc """
  Claims `ids`, returning the ones this caller won and the ones that were
  already in flight.

  Each id is inserted with `:ets.insert_new/2`, so exactly one concurrent
  claimant wins it. `ids` is expected to be unique; a duplicate inside one
  call reports the later occurrence as already in flight.
  """
  @spec claim([id()], GenServer.name()) :: {[id()], [id()]}
  def claim(ids, name \\ __MODULE__) do
    table = table(name)

    Enum.reduce(ids, {[], []}, fn id, {claimed, in_flight} ->
      if :ets.insert_new(table, {id}) do
        {[id | claimed], in_flight}
      else
        {claimed, [id | in_flight]}
      end
    end)
    |> reverse_pair()
  end

  @doc """
  Releases `ids`, making them claimable again.

  Idempotent: releasing an id that is not in the set is a no-op, so the
  abandon paths may run twice without reopening another batch's claim.
  """
  @spec release([id()], GenServer.name()) :: :ok
  def release(ids, name \\ __MODULE__) do
    table = table(name)
    Enum.each(ids, &:ets.delete(table, &1))
    :ok
  end

  @doc """
  Empties the set.

  Only correct on Writer boot, where no commit is in flight (see the
  moduledoc).
  """
  @spec clear(GenServer.name()) :: :ok
  def clear(name \\ __MODULE__) do
    :ets.delete_all_objects(table(name))
    :ok
  end

  @doc """
  Returns the number of ids currently claimed, the source for the
  `ebb.writer.in_flight_action_ids` gauge.

  Returns `0` when the tracker's table has been deleted. Raises when the
  tracker was never started, matching `WatermarkTracker`'s readers, so a
  misconfigured sampler fails loudly instead of reporting a false zero.
  """
  @spec size(GenServer.name()) :: non_neg_integer()
  def size(name \\ __MODULE__) do
    case :ets.info(table(name), :size) do
      :undefined -> 0
      size -> size
    end
  end

  defp reverse_pair({claimed, in_flight}), do: {Enum.reverse(claimed), Enum.reverse(in_flight)}

  defp table(name), do: :persistent_term.get({name, :table})

  @impl true
  def init(opts) do
    name = Keyword.get(opts, :name, __MODULE__)
    table = Keyword.get(opts, :table, @default_table)

    :persistent_term.put({name, :table}, table)

    :ets.new(table, [
      :set,
      :public,
      :named_table,
      read_concurrency: true,
      write_concurrency: true
    ])

    {:ok, %{name: name, table: table}}
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
