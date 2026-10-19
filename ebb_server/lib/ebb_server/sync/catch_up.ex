defmodule EbbServer.Sync.CatchUp do
  @moduledoc """
  Stateless catch-up reads scoped to a single Group.

  Uses the pre-indexed `cf_group_actions` column family to efficiently
  retrieve all actions for a group in GSN order, regardless of how many
  entities the group contains. Each Action is filtered to the Updates
  whose persisted per-Update scope includes the group, so a spanning
  Action contributes to a group's stream only what belongs to it (#473).
  """

  alias EbbServer.Storage.{
    ActionFormat,
    ActionScope,
    PermissionChecker,
    RocksDB,
    WatermarkTracker
  }

  alias EbbServer.Telemetry

  @default_limit 200

  @type result ::
          {:ok, [map()], %{next_offset: non_neg_integer() | nil, up_to_date: boolean()}}
          | {:error, :not_member}

  @doc """
  Returns paginated actions for a group, starting from the given GSN offset.

  ## Parameters

    - `group_id`: The group to fetch actions for
    - `actor_id`: The actor requesting the catch-up (for membership check)
    - `offset`: GSN to start from (exclusive, actions with GSN > offset are returned)
    - `opts`: Keyword options
      - `:limit` - Maximum actions to return (default 200)

  ## Returns

    - `{:ok, actions, meta}` on success where `meta` contains pagination info
    - `{:error, :not_member}` when the actor is not a member of the group
  """
  @spec catch_up_group(String.t(), String.t(), non_neg_integer(), keyword()) :: result()
  def catch_up_group(group_id, actor_id, offset \\ 0, opts \\ []) do
    limit = Keyword.get(opts, :limit, @default_limit)

    if PermissionChecker.member_of_group?(group_id, actor_id) do
      result = perform_catch_up(group_id, offset, limit)
      emit_catch_up(result, group_id, offset)
      result
    else
      {:error, :not_member}
    end
  end

  defp perform_catch_up(group_id, offset, limit) do
    cf_group = RocksDB.cf_group_actions()
    watermark = WatermarkTracker.committed_watermark()

    to_key_gsn = if watermark == 0, do: 1_000_000, else: watermark + 1
    from_key = RocksDB.encode_group_action_key(group_id, offset + 1)
    to_key = RocksDB.encode_group_action_key(group_id, to_key_gsn)

    entries =
      cf_group
      |> RocksDB.range_iterator(from_key, to_key)
      |> Enum.to_list()

    build_response(entries, limit, group_id)
  end

  defp build_response([], _limit, _group_id) do
    {:ok, [], %{next_offset: nil, up_to_date: true}}
  end

  defp build_response(entries, limit, group_id) do
    {gsns, _last_gsn} = parse_entries(entries)

    actions =
      gsns
      |> fetch_actions_by_gsn()
      |> Enum.map(&scope_action(&1, group_id))
      |> Enum.reject(&is_nil/1)
      |> Enum.sort_by(& &1["gsn"])

    if length(entries) <= limit do
      {:ok, actions, %{next_offset: nil, up_to_date: true}}
    else
      trimmed_actions = Enum.take(actions, limit)

      # Advance by the last entry's GSN, not the last returned Action, so a
      # filtered-out Action can never stall pagination.
      last_gsn =
        case List.last(trimmed_actions) do
          nil -> List.last(gsns)
          action -> action["gsn"]
        end

      {:ok, trimmed_actions, %{next_offset: last_gsn, up_to_date: false}}
    end
  end

  # An Action with no Updates scoped to this group contributes nothing: the
  # group's index entry implies at least one does, but a legacy or corrupt
  # record could disagree, and pagination must not stall on it.
  defp scope_action(action, group_id) do
    case ActionScope.updates_for_group(action, group_id) do
      [] -> nil
      updates -> Map.put(action, "updates", updates)
    end
  end

  defp parse_entries(entries) do
    gsns =
      Enum.map(entries, fn {key, _action_id} ->
        {_group_id, gsn} = RocksDB.decode_group_action_key(key)
        gsn
      end)

    last_gsn = List.last(gsns)
    {gsns, last_gsn}
  end

  defp fetch_actions_by_gsn(gsns) do
    cf_actions = RocksDB.cf_actions()
    keys = Enum.map(gsns, &RocksDB.encode_gsn_key/1)

    RocksDB.multi_get(cf_actions, keys)
    |> Enum.zip(gsns)
    |> Enum.flat_map(fn
      {{:ok, binary}, gsn} -> [ActionFormat.decode(binary, gsn)]
      {:not_found, _gsn} -> []
    end)
  end

  # Only successful reads emit; a full resync is `from_offset == 0` (see the
  # event catalogue in `EbbServer.Telemetry`).
  defp emit_catch_up({:ok, actions, meta}, group_id, from_offset) do
    Telemetry.execute(
      [:sync, :catch_up],
      %{count: 1},
      %{
        group_id: group_id,
        from_offset: from_offset,
        returned: length(actions),
        up_to_date: meta.up_to_date
      }
    )
  end

  defp emit_catch_up(_result, _group_id, _from_offset), do: :ok
end
