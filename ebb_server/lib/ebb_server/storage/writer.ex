defmodule EbbServer.Storage.Writer do
  @moduledoc """
  GenServer that writes actions to RocksDB.

  For Slice 1: single instance, immediate flush (no batching timer).
  Claims GSN ranges from SystemCache and writes to all 5 column families.
  """

  use GenServer

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, opts, name: name)
  end

  @spec write_actions([map()], GenServer.name()) ::
          {:ok, {pos_integer(), pos_integer()}} | {:error, term()}
  def write_actions(actions, name \\ __MODULE__) do
    GenServer.call(name, {:write_actions, actions})
  end

  @impl true
  @spec init(keyword()) :: {:ok, %{rocks_name: GenServer.name()}}
  def init(opts) do
    rocks_name = Keyword.get(opts, :rocks_name, EbbServer.Storage.RocksDB)
    {:ok, %{rocks_name: rocks_name}}
  end

  @doc """
  Validates, assigns GSNs, and persists actions to RocksDB.

  Pipeline:
  1. Validate each action and filter out invalid ones
  2. Reject actions with empty updates (no-op)
  3. Claim a GSN range from SystemCache for the batch
  4. Build a batch of puts across all 5 column families:
     - cf_actions: GSN → full action (ETF encoded)
     - cf_action_dedup: action_id → GSN (duplicate detection)
     - cf_updates: (action_id, update_id) → update (ETF encoded)
     - cf_entity_actions: (subject_id, GSN) → action_id (materialization index)
     - cf_type_entities: (subject_type, subject_id) → <<>> (type index)
  5. Write batch synchronously to RocksDB
  6. Mark affected entities dirty in SystemCache

  Returns `{:ok, {gsn_start, gsn_end}}` on success.
  """
  @impl true
  def handle_call({:write_actions, actions}, _from, state) when is_list(actions) do
    with {:ok, validated} <- validate_actions(actions),
         filtered <- Enum.reject(validated, &(&1["updates"] == [])),
         {:ok, _} <- validate_non_empty(filtered) do
      batch_size = length(filtered)
      {gsn_start, gsn_end} = EbbServer.Storage.SystemCache.claim_gsn_range(batch_size)
      rocks_name = state.rocks_name

      ops =
        filtered
        |> Enum.with_index(gsn_start)
        |> Enum.flat_map(fn {action, gsn} ->
          action_with_gsn = Map.put(action, "gsn", gsn)
          action_etf = :erlang.term_to_binary(action_with_gsn)

          [
            {:put, EbbServer.Storage.RocksDB.cf_actions(rocks_name),
             EbbServer.Storage.RocksDB.encode_gsn_key(gsn), action_etf},
            {:put, EbbServer.Storage.RocksDB.cf_action_dedup(rocks_name), action["id"],
             EbbServer.Storage.RocksDB.encode_gsn_key(gsn)}
          ] ++
            Enum.flat_map(action["updates"], fn update ->
              update_etf = :erlang.term_to_binary(update)

              [
                {:put, EbbServer.Storage.RocksDB.cf_updates(rocks_name),
                 EbbServer.Storage.RocksDB.encode_update_key(action["id"], update["id"]),
                 update_etf},
                {:put, EbbServer.Storage.RocksDB.cf_entity_actions(rocks_name),
                 EbbServer.Storage.RocksDB.encode_entity_gsn_key(update["subject_id"], gsn),
                 action["id"]},
                {:put, EbbServer.Storage.RocksDB.cf_type_entities(rocks_name),
                 EbbServer.Storage.RocksDB.encode_type_entity_key(
                   update["subject_type"],
                   update["subject_id"]
                 ), <<>>}
              ]
            end)
        end)

      case EbbServer.Storage.RocksDB.write_batch(ops, name: rocks_name) do
        :ok ->
          entity_ids =
            filtered
            |> Enum.flat_map(fn action -> action["updates"] end)
            |> Enum.map(fn update -> update["subject_id"] end)
            |> Enum.uniq()

          :ok = EbbServer.Storage.SystemCache.mark_dirty_batch(entity_ids)
          {:reply, {:ok, {gsn_start, gsn_end}}, state}

        {:error, reason} ->
          {:reply, {:error, {:rocksdb_write_failed, reason}}, state}
      end
    else
      {:error, _reason} = error ->
        {:reply, error, state}
    end
  end

  defp validate_actions(actions) do
    valid_actions = Enum.filter(actions, &valid_action?/1)
    {:ok, valid_actions}
  end

  defp valid_action?(%{} = action) do
    is_binary(action["id"]) and
      is_list(action["updates"]) and
      Enum.all?(action["updates"], &valid_update?/1)
  end

  defp valid_update?(%{} = update) do
    is_binary(update["id"]) and
      is_binary(update["subject_id"]) and
      is_binary(update["subject_type"]) and
      update["subject_id"] != "" and
      update["subject_type"] != ""
  end

  defp validate_non_empty([]), do: {:error, :no_valid_actions}
  defp validate_non_empty(actions), do: {:ok, actions}
end
