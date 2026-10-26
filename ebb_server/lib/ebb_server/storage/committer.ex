defmodule EbbServer.Storage.Committer do
  @moduledoc """
  Durability half of the Writer's flush: wraps each `PreparedAction`'s
  already-encoded payload into `cf_*` ops and writes them in one
  `RocksDB.write_batch/2`.

  The Writer owns a `EbbServer.Storage.CommitterPool`, which starts one
  Committer per pool slot under a `DynamicSupervisor`. A batch is handed
  over asynchronously with `commit/5`; the Committer replies
  `{:committer_result, ref, result}` to its owner (the pool), where
  `result` is one of:

  - `:ok` — the batch is durable.
  - `{:error, reason}` — `commit_fn` refused the batch; nothing was
    written.
  - `{:raised, kind, value, stacktrace}` — op assembly or `commit_fn`
    raised, threw, or exited. The Committer stays alive so the pool can
    report the failed range and reuse the worker.

  A real worker death is not a result the Committer can send. The pool
  monitors each worker and turns its `:DOWN` into
  `{:committer_result, ref, {:crashed, reason}}`, which the Writer treats
  like any other failed range. This is what keeps one bad range from
  taking the sequencer or the other in-flight ranges down.

  Everything the Committer touches is immutable: op assembly reads only
  the `PreparedAction` fields, never a system cache, and the GSN range is
  already claimed. That is what makes it safe to run the frame encode
  and the durable write off the sequencer process.

  The Committer monitors its owner (the pool) and stops when it goes
  away. The pool in turn is linked to and monitors the Writer, so a
  normal Writer stop does not leak a process. A worker already inside
  `write_batch` when its owner exits can still finish that NIF call; the
  Writer's restart reconcile treats that range as an orphaned hole and
  never reuses the GSN.

  `[:ebb, :writer, :commit_latency_ms]` spans frame encode + op assembly
  + `write_batch` and is emitted on every outcome, including a raise, so
  the durable-write cost is separable from the sequencer's batch latency.
  The expensive payload build and ETF encode already happened in the
  Prepare pool before the claim.
  """

  use GenServer

  alias EbbServer.Storage.{ActionFormat, PreparedAction, RocksDB}
  alias EbbServer.Telemetry

  @type result ::
          :ok
          | {:error, term()}
          | {:raised, :error | :throw | :exit, term(), Exception.stacktrace()}

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts)
  end

  @doc """
  Queues one prepared batch for the durable write.

  Asynchronous by design: the sequencer must stay responsive while the
  write is in flight. The outcome arrives as
  `{:committer_result, ref, result}` on the owner process.
  """
  @spec commit(GenServer.server(), reference(), [PreparedAction.t()], integer(), integer()) :: :ok
  def commit(committer, ref, prepared, gsn_start, gsn_end) do
    GenServer.cast(committer, {:commit, ref, prepared, gsn_start, gsn_end})
  end

  @impl true
  def init(opts) do
    owner = Keyword.fetch!(opts, :owner)

    {:ok,
     %{
       owner: owner,
       owner_ref: Process.monitor(owner),
       rocks_name: Keyword.fetch!(opts, :rocks_name),
       commit_fn: Keyword.fetch!(opts, :commit_fn),
       ablate: Keyword.get(opts, :ablate, [])
     }}
  end

  @impl true
  def handle_cast({:commit, ref, prepared, gsn_start, gsn_end}, state) do
    result =
      commit_now(prepared, gsn_start, gsn_end,
        rocks_name: state.rocks_name,
        commit_fn: state.commit_fn,
        ablate: state.ablate
      )

    send(state.owner, {:committer_result, ref, result})

    {:noreply, state}
  end

  @doc """
  Runs one commit in the calling process.

  The pool uses it from a worker; the Writer uses it when it has a single
  committer slot, where handing the batch to another process buys no overlap
  and costs a copy and three message hops (#529 Step 0).

  Returns `:ok`, `{:error, reason}`, or `{:raised, kind, value, stacktrace}`,
  and emits `ebb.writer.commit_latency_ms` in either case so the commit's
  share of the flush stays measurable wherever it ran.
  """
  @spec commit_now([PreparedAction.t()], integer(), integer(), keyword()) :: result()
  def commit_now(prepared, gsn_start, gsn_end, opts) do
    state = %{
      rocks_name: Keyword.fetch!(opts, :rocks_name),
      commit_fn: Keyword.fetch!(opts, :commit_fn),
      ablate: Keyword.get(opts, :ablate, [])
    }

    started_at = System.monotonic_time()
    result = build_and_commit(prepared, gsn_start, state)

    Telemetry.execute(
      [:writer, :commit_latency_ms],
      %{duration: System.monotonic_time() - started_at},
      %{gsn_start: gsn_start, gsn_end: gsn_end}
    )

    result
  end

  @impl true
  def handle_info({:DOWN, owner_ref, :process, _owner, _reason}, %{owner_ref: owner_ref} = state) do
    {:stop, :normal, state}
  end

  def handle_info(_message, state), do: {:noreply, state}

  # Assembly is inside the same catch as the write so a raise while
  # framing or assembling ops reports like a raise out of `commit_fn` —
  # the sequencer cannot tell the two apart and neither can the caller.
  defp build_and_commit(prepared, gsn_start, state) do
    ops = build_ops(prepared, gsn_start, state)
    state.commit_fn.(ops, name: state.rocks_name)
  rescue
    error -> {:raised, :error, error, __STACKTRACE__}
  catch
    kind, value -> {:raised, kind, value, __STACKTRACE__}
  end

  # Source order is part of the batch: each Action's log record, dedup row,
  # and group index first; then the flush-scoped indexes. Both are sorted for
  # a reproducible batch: the entity rows are one per subject keyed at that
  # subject's highest GSN in the flush, and the type rows have no GSN
  # component and are written once per unique key.
  defp build_ops(prepared, gsn_start, state) do
    {action_ops, {type_entity_keys, subject_gsns}} =
      prepared
      |> Enum.with_index(gsn_start)
      |> Enum.map_reduce({MapSet.new(), %{}}, fn {action, gsn}, {keys, subject_gsns} ->
        {build_action_ops(action, gsn, state),
         {MapSet.union(keys, MapSet.new(action.type_entity_keys)),
          add_subject_gsns(action, gsn, subject_gsns, state)}}
      end)

    :lists.append(action_ops) ++
      entity_ops(subject_gsns, state) ++
      type_entity_ops(type_entity_keys, state)
  end

  defp build_action_ops(action, gsn, state) do
    rocks_name = state.rocks_name
    action_etf = ActionFormat.frame(action.payload_etf, action.update_scopes)

    [{:put, RocksDB.cf_actions(rocks_name), RocksDB.encode_gsn_key(gsn), action_etf}] ++
      dedup_ops(action, gsn, state) ++
      group_ops(action, gsn, state)
  end

  # `cf_action_dedup` doubles as the commit marker for the sequencer's
  # replay check, so it lands in the same atomic batch as `cf_actions`.
  defp dedup_ops(action, gsn, state) do
    if ablate?(:dedup, state) do
      []
    else
      [{:put, RocksDB.cf_action_dedup(state.rocks_name), action.id, RocksDB.encode_gsn_key(gsn)}]
    end
  end

  defp group_ops(action, gsn, state) do
    if ablate?(:group_index, state) do
      []
    else
      Enum.map(action.groups, fn group_id ->
        key = RocksDB.encode_group_action_key(group_id, gsn)
        {:put, RocksDB.cf_group_actions(state.rocks_name), key, action.id}
      end)
    end
  end

  # A subject's row is keyed at its last GSN in this flush, so the reader's
  # seek from `last_gsn + 1` can only land past the row once every GSN it
  # holds has been applied. The codec deduplicates and sorts the list, so a
  # subject that appears in two Actions of the flush is one row carrying both
  # GSNs.
  defp entity_ops(subject_gsns, state) do
    if entity_actions_ablated?(state) do
      []
    else
      subject_gsns
      |> Enum.map(fn {subject_id, gsns} ->
        {key, value} = RocksDB.encode_entity_gsn_row(subject_id, gsns)
        {:put, RocksDB.cf_entity_actions(state.rocks_name), key, value}
      end)
      |> Enum.sort_by(fn {:put, _cf, key, _value} -> key end)
    end
  end

  defp add_subject_gsns(action, gsn, acc, state) do
    if entity_actions_ablated?(state) do
      acc
    else
      Enum.reduce(action.updates, acc, fn update, acc ->
        Map.update(acc, update.subject_id, [gsn], &[gsn | &1])
      end)
    end
  end

  defp type_entity_ops(keys, state) do
    if type_entities_ablated?(state) do
      []
    else
      keys
      |> Enum.sort()
      |> Enum.map(fn key ->
        {:put, RocksDB.cf_type_entities(state.rocks_name), key, <<>>}
      end)
    end
  end

  defp ablate?(phase, state), do: phase in state.ablate

  defp entity_actions_ablated?(state),
    do: ablate?(:entity_actions, state) or ablate?(:entity_index, state)

  defp type_entities_ablated?(state),
    do: ablate?(:type_entities, state) or ablate?(:entity_index, state)
end
