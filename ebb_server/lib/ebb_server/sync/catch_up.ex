defmodule EbbServer.Sync.CatchUp do
  @moduledoc """
  Stateless catch-up reads scoped to a single Group.

  Uses the pre-indexed `cf_group_actions` column family to efficiently
  retrieve all actions for a group in GSN order, regardless of how many
  entities the group contains.
  """

  alias EbbServer.Storage.{GroupCache, RocksDB, WatermarkTracker}

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

    case verify_membership(actor_id, group_id) do
      :ok -> perform_catch_up(group_id, offset, limit)
      {:error, _} = error -> error
    end
  end

  defp verify_membership(actor_id, group_id) do
    case GroupCache.get_permissions(actor_id, group_id) do
      nil -> {:error, :not_member}
      _ -> :ok
    end
  end

  defp perform_catch_up(group_id, offset, limit) do
    cf_group = RocksDB.cf_group_actions()
    watermark = WatermarkTracker.committed_watermark()

    to_key_gsn = if watermark == 0, do: 1_000_000, else: watermark + 1
    from_key = <<group_id::binary, offset + 1::unsigned-big-integer-size(64)>>
    to_key = <<group_id::binary, to_key_gsn::unsigned-big-integer-size(64)>>

    entries =
      cf_group
      |> RocksDB.range_iterator(from_key, to_key)
      |> Enum.to_list()

    build_response(entries, limit)
  end

  defp build_response([], _limit) do
    {:ok, [], %{next_offset: nil, up_to_date: true}}
  end

  defp build_response(entries, limit) do
    {gsns, _last_gsn} = parse_entries(entries)

    actions =
      gsns
      |> fetch_actions_by_gsn()
      |> Enum.sort_by(& &1["gsn"])

    if length(entries) <= limit do
      {:ok, actions, %{next_offset: nil, up_to_date: true}}
    else
      trimmed_actions = Enum.take(actions, limit)
      last_gsn = List.last(trimmed_actions)["gsn"]
      {:ok, trimmed_actions, %{next_offset: last_gsn, up_to_date: false}}
    end
  end

  defp parse_entries(entries) do
    gsns =
      Enum.map(entries, fn {key, _action_id} ->
        key_size = byte_size(key)
        gsn_bytes = 8
        group_id_size = key_size - gsn_bytes
        <<_group_id::binary-size(group_id_size), gsn::unsigned-big-integer-size(64)>> = key
        gsn
      end)

    last_gsn = List.last(gsns)
    {gsns, last_gsn}
  end

  defp fetch_actions_by_gsn(gsns) do
    cf_actions = RocksDB.cf_actions()
    keys = Enum.map(gsns, &RocksDB.encode_gsn_key/1)

    keys
    |> RocksDB.multi_get(cf_actions)
    |> Enum.map(fn
      {:ok, binary} -> :erlang.binary_to_term(binary, [:safe])
      :not_found -> nil
    end)
    |> Enum.reject(&is_nil/1)
  end
end
