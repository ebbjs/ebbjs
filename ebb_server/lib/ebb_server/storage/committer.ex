defmodule EbbServer.Storage.Committer do
  @moduledoc """
  Durability half of the Writer's flush: wraps each `PreparedAction`'s
  already-encoded payload into `cf_*` ops and writes them in one
  `RocksDB.write_batch/2`.

  The Writer (the sequencer) starts one Committer, linked, in its own
  `init/1`. A batch is handed over asynchronously with
  `commit/5`; the Committer replies `{:committer_result, ref, result}` to
  its owner, where `result` is one of:

  - `:ok` — the batch is durable.
  - `{:error, reason}` — `commit_fn` refused the batch; nothing was
    written.
  - `{:raised, kind, value, stacktrace}` — op assembly or `commit_fn`
    raised, threw, or exited. The Committer stays alive: the sequencer
    owns the abandon-then-re-raise policy, so the crash keeps surfacing in
    the Writer process where the flush used to raise.

  Everything the Committer touches is immutable: op assembly reads only
  the `PreparedAction` fields, never a system cache, and the GSN range is
  already claimed. That is what makes it safe to run the wrapper encode
  and the durable write off the sequencer process.

  Because the Committer is linked, an unexpected death takes the Writer
  down with it, and `EbbServer.Storage.Supervisor` / the Writer's `init/1`
  reconcile heal the claimed-but-unresolved range. The Committer also
  monitors its owner and stops when the Writer goes away, so a normal
  Writer stop does not leak a process.

  `[:ebb, :writer, :commit_latency_ms]` spans wrapper encode + op assembly
  + `write_batch` and is emitted on every outcome, including a raise, so
  the durable-write cost is separable from the sequencer's batch latency.
  The expensive payload build and ETF encode already happened in the
  sequencer before the claim.
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
    started_at = System.monotonic_time()
    result = build_and_commit(prepared, gsn_start, state)

    Telemetry.execute(
      [:writer, :commit_latency_ms],
      %{duration: System.monotonic_time() - started_at},
      %{gsn_start: gsn_start, gsn_end: gsn_end}
    )

    send(state.owner, {:committer_result, ref, result})

    {:noreply, state}
  end

  @impl true
  def handle_info({:DOWN, owner_ref, :process, _owner, _reason}, %{owner_ref: owner_ref} = state) do
    {:stop, :normal, state}
  end

  def handle_info(_message, state), do: {:noreply, state}

  # Assembly is inside the same catch as the write so a raise while
  # wrapping or assembling ops reports like a raise out of `commit_fn` —
  # the sequencer cannot tell the two apart and neither can the caller.
  defp build_and_commit(prepared, gsn_start, state) do
    ops = build_ops(prepared, gsn_start, state)
    state.commit_fn.(ops, name: state.rocks_name)
  rescue
    error -> {:raised, :error, error, __STACKTRACE__}
  catch
    kind, value -> {:raised, kind, value, __STACKTRACE__}
  end

  # Source order is part of the batch: the log record, then the dedup
  # index, then this Action's group index, then the per-Update entity
  # index. The type index is flush-scoped (its key has no GSN component)
  # and is appended once, sorted for a reproducible batch.
  defp build_ops(prepared, gsn_start, state) do
    {action_ops, type_entity_keys} =
      prepared
      |> Enum.with_index(gsn_start)
      |> Enum.map_reduce(MapSet.new(), fn {action, gsn}, keys ->
        {ops, action_keys} = build_action_ops(action, gsn, state)
        {ops, MapSet.union(keys, MapSet.new(action_keys))}
      end)

    type_ops =
      if ablate?(:entity_index, state),
        do: [],
        else: type_entity_ops(type_entity_keys, state.rocks_name)

    :lists.append(action_ops) ++ type_ops
  end

  defp build_action_ops(action, gsn, state) do
    rocks_name = state.rocks_name
    action_etf = ActionFormat.wrap(action.payload_etf, action.update_scopes)

    ops =
      [{:put, RocksDB.cf_actions(rocks_name), RocksDB.encode_gsn_key(gsn), action_etf}] ++
        dedup_ops(action, gsn, state) ++
        group_ops(action, gsn, state) ++
        update_ops(action, gsn, state)

    {ops, action.type_entity_keys}
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

  defp update_ops(action, gsn, state) do
    if ablate?(:entity_index, state) do
      []
    else
      Enum.map(action.updates, fn update ->
        {:put, RocksDB.cf_entity_actions(state.rocks_name),
         RocksDB.encode_entity_gsn_key(update.subject_id, gsn), action.id}
      end)
    end
  end

  defp type_entity_ops(keys, rocks_name) do
    keys
    |> Enum.sort()
    |> Enum.map(fn key -> {:put, RocksDB.cf_type_entities(rocks_name), key, <<>>} end)
  end

  defp ablate?(phase, state), do: phase in state.ablate
end
