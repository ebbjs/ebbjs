defmodule EbbServer.Sync.CatchUp do
  @moduledoc """
  Stateless catch-up reads scoped to a single Group.

  Uses the pre-indexed `cf_group_actions` column family to efficiently
  retrieve a group's Actions in GSN order, regardless of how many entities
  the group contains. A page consumes at most `limit` index rows (#423), so
  the cost of one page does not grow with the group's backlog. Each Action
  is filtered to the Updates whose persisted per-Update scope includes the
  group, so a spanning Action contributes to a group's stream only what
  belongs to it (#473).
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
  @max_gsn 0xFFFFFFFFFFFFFFFF

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
      - `:limit` - Upper bound on the `cf_group_actions` rows one page consumes,
        and so on the Actions it returns (default 200). A page can return fewer
        Actions than `limit`, and a page that consumes exactly `limit` rows
        reports `up_to_date: false` even when nothing is left, so a caller that
        reaches the end makes one more (empty) request. Values below 1 are
        treated as 1.

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
    page_size = max(limit, 1)

    from_key = RocksDB.encode_group_action_key(group_id, offset + 1)
    to_key = RocksDB.encode_group_action_key(group_id, upper_bound_gsn(watermark))

    # A page is deliberately NOT filled to its requested size: an index row can
    # be scope-filtered, sit next to a GSN hole, or have no `cf_actions` row,
    # and scanning on to fill the page would make it O(backlog) again for a
    # sparse index. A short (or empty) page is correct because `next_offset`
    # still advances (see below).
    entries =
      cf_group
      |> RocksDB.range_iterator(from_key, to_key)
      |> Stream.take_while(&own_row?(&1, group_id))
      |> Enum.take(page_size)

    # A page that stopped short of its requested size reached the end of the
    # group's resolved range. One that exactly fills it reports that the caller
    # may find more, even when nothing is left.
    up_to_date? = length(entries) < page_size

    gsns = Enum.map(entries, &entry_gsn/1)
    fetched_actions = fetch_actions_by_gsn(gsns)

    # `cf_group_actions` keys are `group_id <> u64-big-endian-gsn`, and RocksDB
    # iterates in byte order, so these rows are already in GSN order; sorting
    # them would be redundant work on every page.
    actions =
      fetched_actions
      |> Enum.map(&scope_action(&1, group_id))
      |> Enum.reject(&is_nil/1)

    emit_catch_up_read(group_id, offset, length(gsns), length(fetched_actions))

    if up_to_date? do
      {:ok, actions, %{next_offset: nil, up_to_date: true}}
    else
      # Advance by the last index row consumed, never by the last returned
      # Action and never by the row count: rows that filter out or have no
      # `cf_actions` row must still move the cursor or the client stalls
      # (#473), and the frontier leaves GSN holes by design. A page short of
      # `up_to_date` always consumed a row, so `next_offset` is never nil.
      {:ok, actions, %{next_offset: List.last(gsns), up_to_date: false}}
    end
  end

  # A group id is a variable-length key prefix, so the scan range can also admit
  # rows of groups whose id merely extends this one. Those keys sort after every
  # row of this group, and a legacy unscoped Action among them would be
  # delivered whole to the wrong group. Stopping at the first foreign row keeps
  # the page group-local and `next_offset` an own GSN without giving up the
  # page's size bound.
  defp own_row?({key, _action_id}, group_id) do
    case RocksDB.decode_group_action_key(key) do
      {^group_id, _gsn} -> true
      _ -> false
    end
  end

  # The frontier's next GSN is the exclusive scan bound. GSNs are unsigned
  # 64-bit, so the bound is clamped at the encoding's ceiling. The frontier is 0
  # on a database that has never resolved a range, which is not a usable bound:
  # the largest encodable GSN stands in for it, and that GSN is unreachable, so
  # excluding it costs nothing.
  defp upper_bound_gsn(0), do: @max_gsn
  defp upper_bound_gsn(watermark), do: min(watermark + 1, @max_gsn)

  # An Action with no Updates scoped to this group contributes nothing: the
  # group's index entry implies at least one does, but a legacy or corrupt
  # record could disagree, and pagination must not stall on it.
  defp scope_action(action, group_id) do
    case ActionScope.updates_for_group(action, group_id) do
      [] -> nil
      updates -> Map.put(action, "updates", updates)
    end
  end

  defp entry_gsn({key, _action_id}) do
    {_group_id, gsn} = RocksDB.decode_group_action_key(key)
    gsn
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

  # The observable form of the #423 bound; the `EbbServer.Telemetry` event
  # catalogue explains the counters.
  defp emit_catch_up_read(group_id, from_offset, index_rows, actions_fetched) do
    Telemetry.execute(
      [:sync, :catch_up_read],
      %{index_rows: index_rows, actions_fetched: actions_fetched},
      %{group_id: group_id, from_offset: from_offset}
    )
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
