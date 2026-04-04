defmodule EbbServer.Storage.Writer do
  @moduledoc """
  GenServer that writes actions to RocksDB.

  For Slice 1: single instance, immediate flush (no batching timer).
  Claims GSN ranges from SystemCache and writes to all 5 column families.
  """

  use GenServer

  alias EbbServer.Storage.{RocksDB, SystemCache}

  @type t :: %__MODULE__{
          rocks_name: GenServer.name(),
          dirty_set: atom(),
          gsn_counter: :atomics.atomics(),
          group_members: atom(),
          relationships: atom(),
          relationships_by_group: atom()
        }
  defstruct [
    :rocks_name,
    :dirty_set,
    :gsn_counter,
    :group_members,
    :relationships,
    :relationships_by_group
  ]

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
    group_members = Keyword.get(opts, :group_members, :ebb_group_members)
    relationships = Keyword.get(opts, :relationships, :ebb_relationships)

    relationships_by_group =
      Keyword.get(opts, :relationships_by_group, :ebb_relationships_by_group)

    {:ok,
     %__MODULE__{
       rocks_name: rocks_name,
       dirty_set: dirty_set,
       gsn_counter: gsn_counter,
       group_members: group_members,
       relationships: relationships,
       relationships_by_group: relationships_by_group
     }}
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

      {gsn_start, gsn_end} =
        SystemCache.claim_gsn_range(batch_size, state.gsn_counter)

      rocks_name = state.rocks_name

      ops =
        filtered
        |> Enum.with_index(gsn_start)
        |> Enum.flat_map(fn {action, gsn} -> build_action_ops(action, gsn, rocks_name) end)

      write_and_respond(
        ops,
        filtered,
        gsn_start,
        gsn_end,
        empty_update_rejected,
        state,
        rocks_name
      )
    end
  end

  defp write_and_respond(
         ops,
         filtered,
         gsn_start,
         gsn_end,
         empty_update_rejected,
         state,
         rocks_name
       ) do
    case RocksDB.write_batch(ops, name: rocks_name) do
      :ok ->
        entity_ids =
          filtered
          |> Enum.flat_map(fn action -> action["updates"] end)
          |> Enum.map(fn update -> update["subject_id"] end)
          |> Enum.uniq()

        :ok = SystemCache.mark_dirty_batch(entity_ids, state.dirty_set)
        update_system_caches(filtered, state)
        {:reply, {:ok, {gsn_start, gsn_end}, empty_update_rejected}, state}

      {:error, reason} ->
        {:reply, {:error, {:rocksdb_write_failed, reason}}, state}
    end
  end

  defp update_system_caches(actions, state) do
    Enum.each(actions, &process_action_updates(&1, state))
  end

  defp process_action_updates(action, state) do
    Enum.each(action["updates"], &process_single_update(&1, state))
  end

  defp process_single_update(update, state) do
    case update["subject_type"] do
      "groupMember" -> handle_group_member_update(update, state)
      "relationship" -> handle_relationship_update(update, state)
      _ -> :ok
    end
  end

  defp handle_group_member_update(update, state) do
    case update["method"] do
      method when method in ["put", "patch"] ->
        data = update["data"]
        fields = data["fields"] || %{}

        SystemCache.put_group_member(
          %{
            id: update["subject_id"],
            actor_id: get_field_value(fields, "actor_id"),
            group_id: get_field_value(fields, "group_id"),
            permissions: get_field_value(fields, "permissions")
          },
          state.group_members
        )

      "delete" ->
        SystemCache.delete_group_member(update["subject_id"], state.group_members)
    end
  end

  defp handle_relationship_update(update, state) do
    case update["method"] do
      method when method in ["put", "patch"] ->
        data = update["data"]

        SystemCache.put_relationship(
          %{
            id: update["subject_id"],
            source_id: data["source_id"] || get_field_value(data["fields"], "source_id"),
            target_id: data["target_id"] || get_field_value(data["fields"], "target_id"),
            type: data["type"] || get_field_value(data["fields"], "type"),
            field: data["field"] || get_field_value(data["fields"], "field")
          },
          relationships: state.relationships,
          relationships_by_group: state.relationships_by_group
        )

      "delete" ->
        SystemCache.delete_relationship(
          update["subject_id"],
          relationships: state.relationships,
          relationships_by_group: state.relationships_by_group
        )
    end
  end

  defp get_field_value(nil, _field), do: nil

  defp get_field_value(fields, field) do
    case fields[field] do
      %{"value" => value} -> value
      value when is_binary(value) -> value
      _ -> nil
    end
  end

  defp build_action_ops(action, gsn, rocks_name) do
    action_with_gsn = Map.put(action, "gsn", gsn)
    action_etf = :erlang.term_to_binary(action_with_gsn)

    [
      {:put, RocksDB.cf_actions(rocks_name), RocksDB.encode_gsn_key(gsn), action_etf},
      {:put, RocksDB.cf_action_dedup(rocks_name), action["id"], RocksDB.encode_gsn_key(gsn)}
    ] ++
      Enum.flat_map(action["updates"], fn update ->
        build_update_ops(action["id"], update, gsn, rocks_name)
      end)
  end

  defp build_update_ops(action_id, update, gsn, rocks_name) do
    update_etf = :erlang.term_to_binary(update)

    [
      {:put, RocksDB.cf_updates(rocks_name), RocksDB.encode_update_key(action_id, update["id"]),
       update_etf},
      {:put, RocksDB.cf_entity_actions(rocks_name),
       RocksDB.encode_entity_gsn_key(update["subject_id"], gsn), action_id},
      {:put, RocksDB.cf_type_entities(rocks_name),
       RocksDB.encode_type_entity_key(
         update["subject_type"],
         update["subject_id"]
       ), <<>>}
    ]
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
    with {:ok, _} <- validate_action_id(action["id"]),
         {:ok, _} <- validate_action_updates(action["updates"]) do
      validate_updates_list(action["updates"])
    end
  end

  defp validate_action_id(id) do
    if is_binary(id), do: {:ok, id}, else: {:error, "action id must be a string"}
  end

  defp validate_action_updates(updates) do
    if is_list(updates), do: {:ok, updates}, else: {:error, "action updates must be a list"}
  end

  defp validate_updates_list([]), do: :ok

  defp validate_updates_list([update | rest]) do
    case valid_update?(update) do
      :ok -> validate_updates_list(rest)
      error -> error
    end
  end

  defp valid_update?(%{} = update) do
    with :ok <- validate_update_id(update["id"]),
         :ok <- validate_subject_id(update["subject_id"]),
         :ok <- validate_subject_type(update["subject_type"]),
         :ok <- validate_data(update["data"], update["method"], update["subject_type"]) do
      validate_method(update["method"])
    end
  end

  defp validate_update_id(id) do
    if is_binary(id), do: :ok, else: {:error, "update id must be a string"}
  end

  defp validate_subject_id(subject_id) do
    if is_binary(subject_id) and subject_id != "",
      do: :ok,
      else: {:error, "update subject_id must be a non-empty string"}
  end

  defp validate_subject_type(subject_type) do
    if is_binary(subject_type) and subject_type != "",
      do: :ok,
      else: {:error, "update subject_type must be a non-empty string"}
  end

  defp validate_data(data, method, subject_type) when method in ["put", "patch"] do
    cond do
      subject_type == "groupMember" -> validate_group_member_data(data)
      subject_type == "relationship" -> validate_relationship_data(data)
      is_map(data) and is_map(data["fields"]) -> :ok
      true -> {:error, "update data.fields must be a map for put/patch"}
    end
  end

  defp validate_data(data, "delete", _subject_type) do
    if is_map(data), do: :ok, else: {:error, "update data must be a map"}
  end

  defp validate_data(_data, _method, _subject_type), do: {:error, "update data must be a map"}

  defp validate_group_member_data(data) do
    if is_map(data) do
      fields = data["fields"] || %{}

      if is_map(fields) and fields["actor_id"] != nil and fields["group_id"] != nil do
        :ok
      else
        {:error, "update data.fields must contain actor_id and group_id for groupMember"}
      end
    else
      {:error, "update data must be a map"}
    end
  end

  defp validate_relationship_data(data) do
    if is_map(data) do
      has_top_level = data["source_id"] != nil and data["target_id"] != nil
      fields = data["fields"] || %{}
      has_nested = is_map(fields) and fields["source_id"] != nil and fields["target_id"] != nil

      if has_top_level or has_nested do
        :ok
      else
        {:error,
         "update data must contain source_id and target_id (top-level or in fields) for relationship"}
      end
    else
      {:error, "update data must be a map"}
    end
  end

  defp validate_method(method) do
    if method in ["put", "patch", "delete"],
      do: :ok,
      else: {:error, "update method must be one of: put, patch, delete"}
  end
end
