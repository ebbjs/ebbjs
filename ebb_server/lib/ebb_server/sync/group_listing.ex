defmodule EbbServer.Sync.GroupListing do
  @moduledoc """
  Cold-bootstrap listing of a Group's current state as of a resolution frontier.

  ## What a listing is

  `W = WatermarkTracker.committed_watermark()` is read **once, before the
  first row**, and every page carries it. Every effect with `gsn <= W` that
  the group's view can observe is in the listing (this page or an earlier
  one); every Action above `W` is the caller's tail. That split is what lets
  a client seed a local base and then tail from `W` without a gap.

  The row set is the group's state, not just its contents: the `group` row,
  its live `groupMember` rows, every live `entityGroup` row in the group,
  and the live entities those rows name. `group` and `groupMember` carry no
  `entityGroup` row, so a membership join alone would miss them.

  ## Materialization

  The SQLite read model is materialized lazily and `DirtyTracker` marks are
  in-memory only. Boot repairs the gap that leaves: the cache rebuild
  re-marks every `cf_type_entities` row dirty (#564), so the first read or
  per-type query after a restart replays the row's delta. This module still
  materializes the group's dirty system rows before paging and **every**
  returned row unconditionally as it is read. A seeded row that is stale at
  `W` would be stale forever, because the tail never revisits it, and that
  `W` claim must not depend on the dirty set being a complete record.

  ## Pagination

  Keyset, never `OFFSET`. Phase 0 is the bounded prefix — the `group` row,
  then its `groupMember` rows keyed on `(actor_id, id)` through
  `idx_entities_group_member`. Phase 1 pages the group's `entityGroup` rows
  by row id through `idx_entities_entity_group_page`, fetching the named
  entities for the page in one `id IN (...)` lookup.

  An `entityGroup` row may name an entity that is also named by another
  membership row; a repeat is idempotent for the client, whose store is
  keyed by entity id. Rows are deduplicated within a page only.

  The cursor is opaque: base64url of `{v, group_id, w, key}`. The `w` is
  echoed on every page so a client can assert it did not move, and a cursor
  whose `group_id` is not the path's group is rejected instead of honoured.
  A cursor whose `w` is no longer the current frontier is still honoured:
  `W` is a claim about the past, not a lease.
  """

  alias EbbServer.Storage.{
    DirtyTracker,
    EntityStore,
    PermissionChecker,
    PermissionHelper,
    SQLite,
    WatermarkTracker
  }

  @default_limit 200
  @max_limit 1000
  @token_version 1
  @system_types PermissionHelper.system_entity_types()

  @default_sqlite_name EbbServer.Storage.SQLite
  @default_dirty_set :ebb_dirty_set

  # `:start` never appears in a cursor: it means the group row has not been
  # emitted yet, and a page always emits at least one row before handing one
  # out. `{:members, nil, nil}` is "group row done, members from the start".
  @type cursor_key ::
          :start
          | {:members, String.t() | nil, String.t() | nil}
          | {:memberships, String.t() | nil}

  @type page :: %{
          group_id: String.t(),
          watermark: non_neg_integer(),
          cursor: String.t() | nil,
          has_more: boolean(),
          entities: [map()]
        }

  @type error :: {:error, :not_member | :bad_cursor | :invalid_limit | :materialization_failed}

  @doc """
  Returns one page of the group's state as of `W`, plus the cursor for the
  next page.

  ## Options

    - `:cursor` - opaque token from a previous page (`nil` starts at page 1,
      which is also the only page that reads the frontier)
    - `:limit` - maximum membership keys in the page, 200 by default, 1000
      at most; a membership key may ship its entity too, so a page can carry
      up to twice that many entity objects
    - `:sqlite_name`, `:rocks_name`, `:dirty_set` - isolated storage
      instances (tests)
    - `:watermark_tracker` - the tracker process name (tests)
    - `:after_watermark` - test seam: a 0-arity fun invoked once after the
      frontier is read and before any row is materialized

  A non-member and an unknown group both return `{:error, :not_member}`, so
  the endpoint leaks no group existence.
  """
  @spec list(String.t(), String.t(), keyword()) :: {:ok, page()} | error()
  def list(group_id, actor_id, opts \\ []) do
    with :ok <- authorize(group_id, actor_id, opts),
         {:ok, limit} <- normalize_limit(Keyword.get(opts, :limit)),
         {:ok, watermark, key} <- resolve_cursor(Keyword.get(opts, :cursor), group_id, opts),
         :ok <- materialize_prefix(key, opts),
         {:ok, entities, next_key, has_more} <- build_page(group_id, limit, key, opts) do
      {:ok,
       %{
         group_id: group_id,
         watermark: watermark,
         cursor: cursor_for(has_more, group_id, watermark, next_key),
         has_more: has_more,
         entities: entities
       }}
    end
  end

  defp cursor_for(true, group_id, watermark, next_key),
    do: encode_cursor(group_id, watermark, next_key)

  defp cursor_for(false, _group_id, _watermark, _next_key), do: nil

  defp authorize(group_id, actor_id, opts) do
    if PermissionChecker.member_of_group?(group_id, actor_id, opts) do
      :ok
    else
      {:error, :not_member}
    end
  end

  defp normalize_limit(nil), do: {:ok, @default_limit}

  defp normalize_limit(limit) when is_integer(limit) and limit > 0 and limit <= @max_limit,
    do: {:ok, limit}

  defp normalize_limit(_limit), do: {:error, :invalid_limit}

  # Page 1 is the only page that reads the frontier: later pages echo the
  # token's `w` so a client sees the same `watermark` on every page of one
  # listing, whichever frontier the server has moved to since.
  defp resolve_cursor(nil, _group_id, opts) do
    watermark = WatermarkTracker.committed_watermark(tracker_name(opts))
    run_after_watermark(opts)
    {:ok, watermark, :start}
  end

  defp resolve_cursor(cursor, group_id, _opts) when is_binary(cursor) do
    with {:ok, json} <- Base.url_decode64(cursor, padding: false),
         {:ok, payload} <- Jason.decode(json),
         {:ok, watermark, key} <- decode_token(payload, group_id) do
      {:ok, watermark, key}
    else
      _ -> {:error, :bad_cursor}
    end
  end

  defp resolve_cursor(_cursor, _group_id, _opts), do: {:error, :bad_cursor}

  defp decode_token(
         %{"v" => @token_version, "group_id" => group_id, "w" => watermark, "key" => key},
         group_id
       )
       when is_integer(watermark) and watermark >= 0 do
    case decode_key(key) do
      {:ok, decoded_key} -> {:ok, watermark, decoded_key}
      :error -> :error
    end
  end

  defp decode_token(_payload, _group_id), do: :error

  defp encode_cursor(group_id, watermark, key) do
    %{"v" => @token_version, "group_id" => group_id, "w" => watermark, "key" => encode_key(key)}
    |> Jason.encode!()
    |> Base.url_encode64(padding: false)
  end

  defp encode_key({:members, nil, nil}), do: [0]
  defp encode_key({:members, actor_id, id}), do: [0, actor_id, id]
  defp encode_key({:memberships, nil}), do: [1]
  defp encode_key({:memberships, id}), do: [1, id]

  defp decode_key([0]), do: {:ok, {:members, nil, nil}}

  defp decode_key([0, actor_id, id]) when is_binary(actor_id) and is_binary(id),
    do: {:ok, {:members, actor_id, id}}

  defp decode_key([1]), do: {:ok, {:memberships, nil}}
  defp decode_key([1, id]) when is_binary(id), do: {:ok, {:memberships, id}}
  defp decode_key(_key), do: :error

  defp run_after_watermark(opts) do
    case Keyword.get(opts, :after_watermark) do
      nil -> :ok
      fun -> fun.()
    end
  end

  # Only page 1 needs the system pass: later pages' rows are materialized
  # unconditionally by `load_live_rows/2`, and a membership committed after
  # the pinned W belongs to the tail.
  defp materialize_prefix(:start, opts) do
    @system_types
    |> DirtyTracker.dirty_entity_ids_for_types(dirty_set(opts))
    |> materialize_all(opts)
  end

  defp materialize_prefix(_key, _opts), do: :ok

  defp build_page(group_id, limit, key, opts) do
    with {:ok, prefix, remaining, next_key} <- build_prefix(group_id, limit, key, opts) do
      cond do
        remaining > 0 ->
          build_membership_page(group_id, remaining, prefix, membership_after(next_key), opts)

        rows_after?(group_id, next_key, opts) ->
          {:ok, prefix, next_key, true}

        true ->
          {:ok, prefix, nil, false}
      end
    end
  end

  # Phase 0 — the bounded prefix. The group row is materialized
  # unconditionally: `group` has no eager boot populator, so it stays lazy
  # like a user type and the listing's `W` guarantee must not rest on the
  # dirty mark being present.
  defp build_prefix(group_id, limit, :start, opts) do
    case fetch_group_row(group_id, opts) do
      {:ok, nil} -> build_prefix_members(group_id, limit, nil, [], opts)
      {:ok, row} -> build_prefix_members(group_id, limit - 1, nil, [row], opts)
      {:error, _reason} -> {:error, :materialization_failed}
    end
  end

  defp build_prefix(group_id, limit, {:members, actor_id, id}, opts) do
    build_prefix_members(group_id, limit, after_pair(actor_id, id), [], opts)
  end

  defp build_prefix(_group_id, limit, {:memberships, _after_id} = key, _opts) do
    {:ok, [], limit, key}
  end

  defp build_prefix_members(_group_id, 0, after_key, acc, _opts) do
    {actor_id, id} = after_key || {nil, nil}
    {:ok, acc, 0, {:members, actor_id, id}}
  end

  defp build_prefix_members(group_id, limit, after_key, acc, opts) do
    members = SQLite.list_group_members(group_id, after_key, limit + 1, sqlite_name(opts))
    {taken, rest} = Enum.split(members, limit)
    remaining = if(rest == [], do: limit - length(taken), else: 0)

    with {:ok, rows} <- emit_members(group_id, taken, opts) do
      next_key =
        case List.last(taken) do
          nil -> {:members, nil, nil}
          {id, actor_id} -> {:members, actor_id, id}
        end

      {:ok, acc ++ rows, remaining, next_key}
    end
  end

  defp build_membership_page(group_id, limit, prefix, after_id, opts) do
    entries =
      SQLite.list_entity_group_memberships(group_id, after_id, limit + 1, sqlite_name(opts))

    {taken, rest} = Enum.split(entries, limit)

    with {:ok, by_id} <- load_live_rows(page_ids(taken), opts) do
      {:ok, prefix ++ membership_rows(taken, by_id), next_membership_key(rest, List.last(taken)),
       rest != []}
    end
  end

  defp page_ids(taken) do
    Enum.flat_map(taken, fn {membership_id, entity_id} -> [membership_id, entity_id] end)
  end

  # A membership row ships followed by the entity it names. Two membership
  # rows can name one entity; a repeat is idempotent for the client but is
  # collapsed within the page.
  defp membership_rows(taken, by_id) do
    {rows, _seen} =
      Enum.reduce(taken, {[], MapSet.new()}, fn {membership_id, entity_id}, {rows, seen} ->
        {rows, seen} = emit_row(rows, seen, by_id, membership_id)

        if entity_id == membership_id,
          do: {rows, seen},
          else: emit_row(rows, seen, by_id, entity_id)
      end)

    Enum.reverse(rows)
  end

  defp next_membership_key(_rest, nil), do: nil
  defp next_membership_key([], _last), do: nil

  defp next_membership_key(_rest, {membership_id, _entity_id}),
    do: {:memberships, membership_id}

  defp membership_after({:members, _actor_id, _id}), do: nil
  defp membership_after({:memberships, after_id}), do: after_id

  defp after_pair(nil, nil), do: nil
  defp after_pair(actor_id, id), do: {actor_id, id}

  defp fetch_group_row(group_id, opts) do
    case EntityStore.materialize(group_id, opts) do
      {:ok, %{type: "group"} = row} -> {:ok, row}
      {:ok, _other} -> {:ok, nil}
      :not_found -> {:ok, nil}
      {:error, _reason} -> {:error, :materialization_failed}
    end
  end

  # The prefix rows are materialized unconditionally too: reading a cached
  # `groupMember` row that is behind the log would place it under the wrong
  # group or actor in the keyset, so the keyset must not trust the dirty set.
  defp emit_members(group_id, taken, opts) do
    ids = Enum.map(taken, fn {id, _actor_id} -> id end)

    with {:ok, by_id} <- load_live_rows(ids, opts) do
      rows =
        taken
        |> Enum.flat_map(fn {id, _actor_id} -> typed_row(by_id, id, "groupMember") end)
        |> Enum.filter(&(group_field(&1) == group_id))

      {:ok, rows}
    end
  end

  defp load_live_rows(ids, opts) do
    with :ok <- materialize_all(ids, opts) do
      rows =
        ids
        |> SQLite.get_entities(sqlite_name(opts))
        |> Map.new(fn row -> {row.id, decode_row(row)} end)

      {:ok, rows}
    end
  end

  defp materialize_all(ids, opts) do
    ids
    |> Enum.reject(&is_nil/1)
    |> Enum.uniq()
    |> Enum.reduce_while(:ok, fn id, :ok ->
      case EntityStore.materialize(id, opts) do
        {:error, _reason} -> {:halt, {:error, :materialization_failed}}
        _materialized -> {:cont, :ok}
      end
    end)
  end

  defp emit_row(rows, seen, by_id, id) do
    cond do
      is_nil(id) -> {rows, seen}
      MapSet.member?(seen, id) -> {rows, seen}
      true -> {Enum.reverse(live_row(by_id, id), rows), MapSet.put(seen, id)}
    end
  end

  defp typed_row(by_id, id, type) do
    case Map.fetch(by_id, id) do
      {:ok, %{type: ^type} = row} -> [row]
      _ -> []
    end
  end

  defp live_row(by_id, id) do
    case Map.fetch(by_id, id) do
      {:ok, row} -> [row]
      :error -> []
    end
  end

  defp rows_after?(group_id, {:members, actor_id, id}, opts) do
    SQLite.list_group_members(group_id, after_pair(actor_id, id), 1, sqlite_name(opts)) != [] or
      SQLite.list_entity_group_memberships(group_id, nil, 1, sqlite_name(opts)) != []
  end

  defp rows_after?(group_id, {:memberships, after_id}, opts) do
    SQLite.list_entity_group_memberships(group_id, after_id, 1, sqlite_name(opts)) != []
  end

  defp group_field(%{data: %{"fields" => %{"group_id" => %{"value" => group_id}}}}), do: group_id
  defp group_field(_row), do: nil

  defp decode_row(%{data: data} = row) when is_binary(data),
    do: %{row | data: Jason.decode!(data)}

  defp decode_row(row), do: row

  defp sqlite_name(opts), do: Keyword.get(opts, :sqlite_name, @default_sqlite_name)
  defp dirty_set(opts), do: Keyword.get(opts, :dirty_set, @default_dirty_set)
  defp tracker_name(opts), do: Keyword.get(opts, :watermark_tracker, WatermarkTracker)
end
