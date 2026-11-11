defmodule EbbServer.Storage.LogFirst.MembershipIndex do
  @moduledoc """
  Spike-only versioned membership (#844, D2): the `as_of: gsn` structure P3
  would resolve against instead of the Writer's mutable caches.

  Every row is a version list, `key => [{from_gsn, value}]`, ascending by
  write. A read at `as_of` is the newest version at or before that GSN, so a
  resolution is a pure function of `(row, gsn)` and two callers can resolve
  the same Action concurrently. There is no overlay, no dirty mark and no
  provisional state; an Action's own Updates are applied at its GSN and read
  back at that GSN, which is the design's "intra-action context" without a
  second mechanism.

  The keys are the rows group resolution needs:

      {:model, entity_id}            -> model | nil
      {:groups, entity_id}           -> MapSet of group ids
      {:membership, row_id}          -> {entity_id, group_id} | nil
      {:group_member, row_id}        -> {group_id, permissions} | nil
      {:relationship_source, row_id} -> source_id | nil

  A delete resolves against the state *before* the Action (`gsn - 1`), because
  the scope a delete is fanned out to is the group it is leaving, and the row
  is gone afterwards. That is the one rule the current writer enforces by
  persisting `update_scopes`; here it is a property of the read.

  Nothing in this module is wired into `Storage.Supervisor` or the write path.
  It is a candidate for P3, measured by `EbbServer.Bench.MembershipDiff`.
  """

  @system_models ~w(group groupMember entityGroup relationship)

  @type gsn :: pos_integer()
  @type state :: %{versions: %{term() => [{gsn(), term()}]}}

  @doc """
  An empty index.
  """
  @spec new() :: state()
  def new, do: %{versions: %{}}

  @doc """
  Appends `value` for `key` at `gsn`, skipping a write that repeats the
  newest value (a put that changes nothing is not a new version).
  """
  @spec put(state(), term(), gsn(), term()) :: state()
  def put(%{versions: versions} = state, key, gsn, value) do
    case Map.get(versions, key, []) do
      [{_gsn, ^value} | _] -> state
      list -> %{state | versions: Map.put(versions, key, [{gsn, value} | list])}
    end
  end

  @doc """
  The newest value for `key` at or before `as_of`, or `nil` if the row did not
  exist yet.
  """
  @spec get(state(), term(), integer()) :: term() | nil
  def get(%{versions: versions}, key, as_of) do
    versions |> Map.get(key, []) |> newest_at_or_before(as_of)
  end

  @doc """
  The newest value strictly before `gsn` — the state a delete resolves against.
  """
  @spec get_before(state(), term(), gsn()) :: term() | nil
  def get_before(state, key, gsn), do: get(state, key, gsn - 1)

  @doc """
  Applies one Action's Updates at `gsn`, in wire order.

  Puts and component drops of a live row change the row; a `delete` removes it.
  System rows other than `entityGroup` are recorded for completeness and do not
  participate in entity group resolution.
  """
  @spec apply_action(state(), gsn(), [map()]) :: state()
  def apply_action(state, gsn, updates) do
    Enum.reduce(updates, state, &apply_update(&2, gsn, &1))
  end

  @doc """
  The scope the Writer would persist for `update` at `gsn`: the group list a
  fan-out or catch-up reader would use.

  Deletes resolve against the pre-Action state, everything else against the
  state including the Action's own rows. A user row whose model at `as_of` is
  not the model the Update names resolves to `[]`, which is the same
  fail-closed answer `EntityIndex` gives for an unknown subject.
  """
  @spec scope(state(), map(), gsn()) :: [String.t()]
  def scope(state, update, gsn) do
    model =
      if is_binary(update["component"]), do: component_model(update["component"]), else: nil

    kind = model || deleted_kind(state, update["subject_id"], gsn)

    case kind do
      "entityGroup" ->
        as_of = if update["method"] == "delete", do: gsn - 1, else: gsn

        case get(state, {:membership, update["subject_id"]}, as_of) do
          nil -> []
          {_entity_id, group_id} -> [group_id]
        end

      "groupMember" ->
        as_of = if update["method"] == "delete", do: gsn - 1, else: gsn

        case get(state, {:group_member, update["subject_id"]}, as_of) do
          nil -> []
          {group_id, _permissions} -> [group_id]
        end

      "relationship" ->
        as_of = if update["method"] == "delete", do: gsn - 1, else: gsn

        case get(state, {:relationship_source, update["subject_id"]}, as_of) do
          nil -> []
          source_id -> groups_at(state, source_id, as_of)
        end

      "group" ->
        [update["subject_id"]]

      _user_model ->
        as_of = if update["method"] == "delete", do: gsn - 1, else: gsn
        subject_id = update["subject_id"]

        if get(state, {:model, subject_id}, as_of) == model,
          do: groups_at(state, subject_id, as_of),
          else: []
    end
  end

  @doc """
  Drops versions older than the newest one at or before `horizon`, keeping that
  one so a read at the horizon still answers. Returns the index and the number
  of versions dropped.
  """
  @spec prune(state(), non_neg_integer()) :: {state(), non_neg_integer()}
  def prune(%{versions: versions}, horizon) do
    {pruned, dropped} =
      Enum.reduce(versions, {%{}, 0}, fn {key, list}, {acc, dropped} ->
        {keep, count} = keep_from(list, horizon, [], 0)
        {Map.put(acc, key, keep), dropped + count}
      end)

    {%{versions: pruned}, dropped}
  end

  @doc """
  How many rows and versions the index holds.
  """
  @spec stats(state()) :: %{keys: non_neg_integer(), versions: non_neg_integer()}
  def stats(%{versions: versions}) do
    %{
      keys: map_size(versions),
      versions: versions |> Map.values() |> Enum.map(&length/1) |> Enum.sum()
    }
  end

  defp apply_update(state, gsn, update) do
    case update["component"] do
      nil -> apply_delete(state, gsn, update["subject_id"])
      component -> apply_component_update(state, gsn, update, component_model(component))
    end
  end

  defp apply_component_update(state, gsn, update, "entityGroup"),
    do: apply_membership(state, gsn, update)

  defp apply_component_update(state, gsn, update, "groupMember"),
    do: apply_group_member(state, gsn, update)

  defp apply_component_update(state, gsn, update, "relationship"),
    do: apply_relationship(state, gsn, update)

  defp apply_component_update(state, _gsn, _update, "group"), do: state

  defp apply_component_update(state, gsn, update, _user_model),
    do: apply_user_row(state, gsn, update)

  # A row delete names the row and carries no component, so the index finds the
  # kind from what it held before the Action.
  defp apply_delete(state, gsn, subject_id) do
    case deleted_kind(state, subject_id, gsn) do
      "entityGroup" ->
        state =
          case get_before(state, {:membership, subject_id}, gsn) do
            nil -> state
            {entity_id, _group_id} -> remove_row_ref(state, gsn, entity_id, subject_id)
          end

        put(state, {:membership, subject_id}, gsn, nil)

      "groupMember" ->
        put(state, {:group_member, subject_id}, gsn, nil)

      "relationship" ->
        put(state, {:relationship_source, subject_id}, gsn, nil)

      _ ->
        state
        |> put({:model, subject_id}, gsn, nil)
        |> put({:rows, subject_id}, gsn, [])
    end
  end

  # Which row a bare `delete` names, from the pre-Action state.
  defp deleted_kind(state, subject_id, gsn) do
    cond do
      get_before(state, {:membership, subject_id}, gsn) != nil -> "entityGroup"
      get_before(state, {:group_member, subject_id}, gsn) != nil -> "groupMember"
      get_before(state, {:relationship_source, subject_id}, gsn) != nil -> "relationship"
      get_before(state, {:model, subject_id}, gsn) != nil -> "user"
      true -> nil
    end
  end

  # A delete removes the pair from the entity's live set. The pair itself is
  # read from the pre-Action state because a delete carries no data.
  # Each component Update carries one field of the row, so the row's version is
  # the merge of the fields seen so far at this GSN. The pair enters the
  # entity's group set once both halves are present.
  defp apply_membership(state, gsn, update) do
    row_id = update["subject_id"]
    {entity_id, group_id} = get(state, {:membership, row_id}, gsn) || {nil, nil}
    value = field_value(update["data"])

    {entity_id, group_id} =
      case component_field(update["component"]) do
        "entity_id" -> {value, group_id}
        "group_id" -> {entity_id, value}
        _ -> {entity_id, group_id}
      end

    state = put(state, {:membership, row_id}, gsn, {entity_id, group_id})

    if is_binary(entity_id) and is_binary(group_id),
      do: add_row_ref(state, gsn, entity_id, row_id),
      else: state
  end

  defp apply_group_member(state, gsn, %{"method" => "delete"} = update),
    do: put(state, {:group_member, update["subject_id"]}, gsn, nil)

  defp apply_group_member(state, gsn, update) do
    row_id = update["subject_id"]
    {group_id, permissions} = get(state, {:group_member, row_id}, gsn) || {nil, nil}
    value = field_value(update["data"])

    {group_id, permissions} =
      case component_field(update["component"]) do
        "group_id" -> {value, permissions}
        "permissions" -> {group_id, value}
        _ -> {group_id, permissions}
      end

    put(state, {:group_member, row_id}, gsn, {group_id, permissions})
  end

  defp apply_relationship(state, gsn, %{"method" => "delete"} = update),
    do: put(state, {:relationship_source, update["subject_id"]}, gsn, nil)

  defp apply_relationship(state, gsn, update) do
    row_id = update["subject_id"]

    case component_field(update["component"]) do
      "source_id" -> put(state, {:relationship_source, row_id}, gsn, field_value(update["data"]))
      _ -> state
    end
  end

  defp apply_user_row(state, gsn, %{"method" => "delete"} = update) do
    subject_id = update["subject_id"]

    state
    |> put({:model, subject_id}, gsn, nil)
    |> put({:rows, subject_id}, gsn, [])
  end

  defp apply_user_row(state, gsn, update) do
    put(state, {:model, update["subject_id"]}, gsn, component_model(update["component"]))
  end

  # An entity's group set is derived from its live membership rows, in row-id
  # order — the order `EntityGroupCache`'s ordered set returns, which is what
  # the Writer persists. Storing the set directly would lose a group while
  # another live row still names it.
  defp groups_at(state, entity_id, as_of) do
    state
    |> get({:rows, entity_id}, as_of)
    |> group_rows()
    |> Enum.flat_map(fn row_id ->
      case get(state, {:membership, row_id}, as_of) do
        {_entity_id, group_id} when is_binary(group_id) -> [group_id]
        _ -> []
      end
    end)
    |> Enum.uniq()
  end

  defp group_rows(nil), do: []
  defp group_rows(rows), do: rows

  # Insertion order, not sorted: `EntityGroupCache.entity_group_entries/2` is
  # an ETS bag lookup, which returns rows in insertion order, and that order is
  # what the Writer persists in `update_scopes`. A resolver that wants the same
  # bytes has to preserve it (or the format has to normalize).
  # A re-put of a live row is the hot-path case (the bench's `hot` window
  # re-puts one membership row every Action), so an already-live row is not
  # appended again: without this, the row list grows per Action and group
  # derivation becomes linear in the number of re-puts.
  defp add_row_ref(state, gsn, entity_id, row_id) do
    rows = get(state, {:rows, entity_id}, gsn) || []

    if row_id in rows,
      do: state,
      else: put(state, {:rows, entity_id}, gsn, rows ++ [row_id])
  end

  defp remove_row_ref(state, gsn, entity_id, row_id) do
    rows = get_before(state, {:rows, entity_id}, gsn) || []
    put(state, {:rows, entity_id}, gsn, List.delete(rows, row_id))
  end

  defp newest_at_or_before([], _as_of), do: nil

  defp newest_at_or_before([{gsn, value} | rest], as_of) do
    if gsn <= as_of, do: value, else: newest_at_or_before(rest, as_of)
  end

  defp keep_from([], _horizon, keep, dropped), do: {Enum.reverse(keep), dropped}

  defp keep_from([{gsn, _} = version | rest], horizon, keep, dropped) do
    if gsn > horizon,
      do: keep_from(rest, horizon, [version | keep], dropped),
      else: {Enum.reverse([version | keep]), dropped + length(rest)}
  end

  defp component_model(component) when is_binary(component) do
    component |> String.split("/", parts: 2) |> hd()
  end

  # Appearance on the wire is a leaf (`%{"value" => v, "hlc" => h}`) or a bare
  # value; both resolve to the value.
  defp field_value(%{"value" => value}), do: value
  defp field_value(value), do: value

  defp component_field(component) do
    case String.split(component, "/", parts: 2) do
      [_model, field] -> field
      _ -> nil
    end
  end

  @doc """
  The model names the resolver treats as system rows.
  """
  def system_models, do: @system_models
end
