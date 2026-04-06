defmodule EbbServer.Storage.Writer do
  @moduledoc """
  GenServer that writes actions to RocksDB.

  For Slice 1: single instance, immediate flush (no batching timer).
  Claims GSN ranges from SystemCache and writes to all 5 column families.
  """

  use GenServer

  alias EbbServer.Storage.{RocksDB, SystemCache}
  alias EbbServer.Storage.PermissionChecker

  @type validated_action :: PermissionChecker.validated_action()
  @type validated_update :: PermissionChecker.validated_update()

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

  @type rejected_action :: %{action: validated_action(), reason: String.t()}
  @type write_result :: {:ok, {pos_integer(), pos_integer()}, [rejected_action()]}

  @spec write_actions([validated_action()], GenServer.name()) :: write_result() | {:error, term()}
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

  Actions are already validated by PermissionChecker before reaching the Writer.
  Pipeline:
  1. Filter out actions with empty updates (safety check)
  2. Claim a GSN range from SystemCache for the batch
  3. Build a batch of puts across all 5 column families:
     - cf_actions: GSN → full action (ETF encoded)
     - cf_action_dedup: action_id → GSN (duplicate detection)
     - cf_updates: (action_id, update_id) → update (ETF encoded)
     - cf_entity_actions: (subject_id, GSN) → action_id (materialization index)
     - cf_type_entities: (subject_type, subject_id) → <<>> (type index)
  4. Write batch synchronously to RocksDB
  5. Mark affected entities dirty in SystemCache

  Returns `{:ok, {gsn_start, gsn_end}, rejected_actions}` on success.
  """
  @impl true
  def handle_call({:write_actions, actions}, _from, state) when is_list(actions) do
    filtered = Enum.reject(actions, &(&1.updates == []))

    if filtered == [] do
      {:reply, {:ok, {0, 0}, []}, state}
    else
      batch_size = length(filtered)

      {gsn_start, gsn_end} =
        SystemCache.claim_gsn_range(batch_size, state.gsn_counter)

      rocks_name = state.rocks_name

      ops =
        filtered
        |> Enum.with_index(gsn_start)
        |> Enum.flat_map(fn {action, gsn} -> build_action_ops(action, gsn, rocks_name) end)

      write_and_respond(ops, filtered, gsn_start, gsn_end, state, rocks_name)
    end
  end

  defp write_and_respond(ops, filtered, gsn_start, gsn_end, state, rocks_name) do
    case RocksDB.write_batch(ops, name: rocks_name) do
      :ok ->
        entity_ids =
          filtered
          |> Enum.flat_map(fn action -> action.updates end)
          |> Enum.map(fn update -> update.subject_id end)
          |> Enum.uniq()

        :ok = SystemCache.mark_dirty_batch(entity_ids, state.dirty_set)
        update_system_caches(filtered, state)
        {:reply, {:ok, {gsn_start, gsn_end}, []}, state}

      {:error, reason} ->
        {:reply, {:error, {:rocksdb_write_failed, reason}}, state}
    end
  end

  defp update_system_caches(actions, state) do
    for action <- actions,
        update <- action.updates,
        update.subject_type in ["groupMember", "relationship"] do
      case update.subject_type do
        "groupMember" -> handle_group_member_update(update, state)
        "relationship" -> handle_relationship_update(update, state)
      end
    end
  end

  defp handle_group_member_update(update, state) do
    case update.method do
      method when method in [:put, :patch] ->
        data = update.data

        # groupMember data is stored flat, not nested in "fields"
        # Data format: %{"actor_id" => "...", "group_id" => "...", "permissions" => [...]}
        actor_id = data["actor_id"] || get_field_value(data["fields"], "actor_id")
        group_id = data["group_id"] || get_field_value(data["fields"], "group_id")
        permissions = data["permissions"] || get_field_value(data["fields"], "permissions")

        SystemCache.put_group_member(
          %{
            id: update.subject_id,
            actor_id: actor_id,
            group_id: group_id,
            permissions: permissions
          },
          state.group_members
        )

      :delete ->
        SystemCache.delete_group_member(update.subject_id, state.group_members)
    end
  end

  defp handle_relationship_update(update, state) do
    case update.method do
      method when method in [:put, :patch] ->
        data = update.data

        # relationship data is stored flat
        # Data format: %{"source_id" => "...", "target_id" => "...", "type" => "...", "field" => "..."}
        source_id = data["source_id"] || get_field_value(data["fields"], "source_id")
        target_id = data["target_id"] || get_field_value(data["fields"], "target_id")
        type = data["type"] || get_field_value(data["fields"], "type")
        field = data["field"] || get_field_value(data["fields"], "field")

        SystemCache.put_relationship(
          %{
            id: update.subject_id,
            source_id: source_id,
            target_id: target_id,
            type: type,
            field: field
          },
          relationships: state.relationships,
          relationships_by_group: state.relationships_by_group
        )

      :delete ->
        SystemCache.delete_relationship(
          update.subject_id,
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
    action_with_gsn = to_storage_format(action, gsn)
    action_etf = :erlang.term_to_binary(action_with_gsn)

    [
      {:put, RocksDB.cf_actions(rocks_name), RocksDB.encode_gsn_key(gsn), action_etf},
      {:put, RocksDB.cf_action_dedup(rocks_name), action.id, RocksDB.encode_gsn_key(gsn)}
    ] ++
      Enum.flat_map(action.updates, fn update ->
        build_update_ops(action.id, update, gsn, rocks_name)
      end)
  end

  defp to_storage_format(action, gsn) do
    %{
      "id" => action.id,
      "actor_id" => action.actor_id,
      "hlc" => action.hlc,
      "gsn" => gsn,
      "updates" =>
        Enum.map(action.updates, fn update ->
          method_str =
            if is_atom(update.method), do: Atom.to_string(update.method), else: update.method

          # For system entities, data is stored flat (not nested in "fields")
          # For user entities, data uses nested format with "fields"
          storage_data =
            if update.subject_type in ["groupMember", "relationship"] do
              update.data
            else
              update.data
            end

          %{
            "id" => update.id,
            "subject_id" => update.subject_id,
            "subject_type" => update.subject_type,
            "method" => method_str,
            "data" => storage_data
          }
        end)
    }
  end

  defp build_update_ops(action_id, update, gsn, rocks_name) do
    update_etf = :erlang.term_to_binary(update)

    [
      {:put, RocksDB.cf_updates(rocks_name), RocksDB.encode_update_key(action_id, update.id),
       update_etf},
      {:put, RocksDB.cf_entity_actions(rocks_name),
       RocksDB.encode_entity_gsn_key(update.subject_id, gsn), action_id},
      {:put, RocksDB.cf_type_entities(rocks_name),
       RocksDB.encode_type_entity_key(
         update.subject_type,
         update.subject_id
       ), <<>>}
    ]
  end
end
