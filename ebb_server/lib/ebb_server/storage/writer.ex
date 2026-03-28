defmodule EbbServer.Storage.Writer do
  @moduledoc """
  GenServer that writes actions to RocksDB.

  For Slice 1: single instance, immediate flush (no batching timer).
  Claims GSN ranges from SystemCache and writes to all 5 column families.
  """

  use GenServer

  @type t :: %__MODULE__{
          rocks_name: GenServer.name(),
          dirty_set: atom(),
          gsn_counter: :atomics.atomics()
        }
  defstruct [:rocks_name, :dirty_set, :gsn_counter]

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, opts, name: name)
  end

  @type rejected_action :: %{action: map(), reason: String.t()}
  @type write_result :: {:ok, {pos_integer(), pos_integer()}, [rejected_action()]}

  @spec write_actions([map()], GenServer.name()) :: write_result() | {:error, term()}
  def write_actions(actions, name \\ __MODULE__) do
    GenServer.call(name, {:write_actions, actions})
  end

  @impl true
  @spec init(keyword()) :: {:ok, t()}
  def init(opts) do
    rocks_name = Keyword.get(opts, :rocks_name, EbbServer.Storage.RocksDB)
    dirty_set = Keyword.get(opts, :dirty_set, :ebb_dirty_set)
    gsn_counter = Keyword.get(opts, :gsn_counter, :persistent_term.get(:ebb_gsn_counter))

    {:ok, %__MODULE__{rocks_name: rocks_name, dirty_set: dirty_set, gsn_counter: gsn_counter}}
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

  Returns `{:ok, {gsn_start, gsn_end}, rejected_actions}` on success.
  """
  @impl true
  def handle_call({:write_actions, actions}, _from, state) when is_list(actions) do
    {validated, prefiltered_rejected} = validate_and_categorize(actions)
    filtered = Enum.reject(validated, &(&1["updates"] == []))
    empty_update_rejected = prefiltered_rejected ++ build_empty_update_rejections(validated)

    if filtered == [] do
      {:reply, {:ok, {0, 0}, empty_update_rejected}, state}
    else
      batch_size = length(filtered)
      {gsn_start, gsn_end} = EbbServer.Storage.SystemCache.claim_gsn_range(batch_size, state.gsn_counter)
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

          :ok = EbbServer.Storage.SystemCache.mark_dirty_batch(entity_ids, state.dirty_set)
          {:reply, {:ok, {gsn_start, gsn_end}, empty_update_rejected}, state}

        {:error, reason} ->
          {:reply, {:error, {:rocksdb_write_failed, reason}}, state}
      end
    end
  end

  defp validate_and_categorize(actions) do
    Enum.reduce(actions, {[], []}, fn action, {valid, rejected} ->
      case valid_action?(action) do
        :ok -> {[action | valid], rejected}
        {:error, reason} -> {valid, [%{action: action, reason: reason} | rejected]}
      end
    end)
    |> then(fn {valid, rejected} -> {Enum.reverse(valid), Enum.reverse(rejected)} end)
  end

  defp build_empty_update_rejections(validated) do
    Enum.flat_map(validated, fn action ->
      if action["updates"] == [] do
        [%{action: action, reason: "no updates"}]
      else
        []
      end
    end)
  end

  defp valid_action?(%{} = action) do
    cond do
      not is_binary(action["id"]) ->
        {:error, "action id must be a string"}

      not is_list(action["updates"]) ->
        {:error, "action updates must be a list"}

      true ->
        Enum.reduce_while(action["updates"], :ok, fn update, _acc ->
          case valid_update?(update) do
            :ok -> {:cont, :ok}
            {:error, reason} -> {:halt, {:error, reason}}
          end
        end)
    end
  end

  defp valid_update?(%{} = update) do
    cond do
      not is_binary(update["id"]) ->
        {:error, "update id must be a string"}

      not is_binary(update["subject_id"]) or update["subject_id"] == "" ->
        {:error, "update subject_id must be a non-empty string"}

      not is_binary(update["subject_type"]) or update["subject_type"] == "" ->
        {:error, "update subject_type must be a non-empty string"}

      not is_map(update["data"]) ->
        {:error, "update data must be a map"}

      update["method"] in ["put", "patch"] and not is_map(update["data"]["fields"]) ->
        {:error, "update data.fields must be a map for put/patch"}

      update["method"] not in ["put", "patch", "delete"] ->
        {:error, "update method must be one of: put, patch, delete"}

      true ->
        :ok
    end
  end
end
