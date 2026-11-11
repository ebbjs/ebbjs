defmodule EbbServer.Storage.LogFirst.MemoryIndex do
  @moduledoc """
  Spike-only option C prototype (#844, C1): the segment log is the only
  synchronous durable act, and every read model is derived from it.

  The shape under test is one ack and one consumer step:

    1. `append_window/3` frames the window's `cf_actions` bytes, writes them as
       `:action_batch` records through `Segment` (D1), `datasync`s and returns.
       That return **is** the ack. Nothing is indexed on this path, so the ack
       costs the log's cost.
    2. `apply_window/2` is the consumer step. It takes the records the append
       produced, decodes each body, and derives the ETS read models. It is
       idempotent in GSN (`last_gsn` only moves forward) and resumable from its
       own position, so a consumer that is behind the log is normal.

  The derived read models, all of them rebuildable by replaying the log:

  | table          | key                    | value                                     |
  | -------------- | ---------------------- | ----------------------------------------- |
  | `offsets`      | `gsn`                  | byte offset of the record                 |
  | `by_action_id` | `action_id`            | `gsn` — the dedup fast path               |
  | `entities`     | `entity_id`            | `{status, model, fields, components, groups, gsn}` |
  | `group_actions`| `{group_id, gsn}`      | `true` — catch-up pages, in GSN order     |
  | `existence`    | `{model, component, entity_id}` | `true` — the `cf_component_entities` index |

  The decoded Action itself is **not** kept in memory: the log holds it, and
  the dense `gsn -> offset` table is what makes reading it back cheap. A
  `gsn -> action` cache would duplicate the log in decoded form at ~3× the
  record's bytes (measured, C1).

  `offsets` is what makes a catch-up page cheap. `Segment`'s own index samples
  every 64th record, so `Segment.read/2` walks up to 63 records to reach one
  GSN; a dense `gsn -> offset` table turns a page read into one `pread` per
  record. Both are measured (`EbbServer.Bench.MemoryIndexDiff`).

  The membership derivation is `MembershipIndex` (D2), not a second copy of it:
  the consumer runs its `apply_action/3` and projects an entity's group set out
  of the documented `{:rows, entity_id}` / `{:membership, row_id}` keys. That
  keeps D2's row-set rule (an entity may have two live rows naming one group)
  and its insertion-order rule in one place.

  The group index is fed from the record's own `update_scopes`, not derived:
  the persisted per-Update scope is the fan-out/catch-up contract, and §7 of
  the design keeps it because resolution at admission is not the same question
  as "which group was this Update delivered to".

  Nothing here is wired into `Storage.Supervisor`, the `Writer`, or the default
  read path. Tables are owned by the process that calls `open/1`.
  """

  alias EbbServer.Storage.{ActionFormat, Component, FieldMerge}
  alias EbbServer.Storage.LogFirst.{MembershipIndex, Segment}

  @tables [:offsets, :by_action_id, :entities, :group_actions, :existence]

  @typedoc """
  An open index: the ETS tables, the segment it derives from, and the
  consumer's own position and membership state.
  """
  @type t :: %__MODULE__{
          tables: %{atom() => :ets.tid()},
          segment: Segment.t(),
          membership: MembershipIndex.state(),
          applied_gsn: non_neg_integer(),
          applied_actions: non_neg_integer()
        }

  @typedoc """
  One appended record with the byte offset the appender wrote it at. The
  offset is append metadata, not record content: a replay recomputes it from
  the record lengths (`Segment` writes records contiguously from offset 0).
  """
  @type entry :: %{kind: atom(), gsn: pos_integer(), body: binary(), offset: non_neg_integer()}

  @enforce_keys [:tables, :segment]
  defstruct tables: nil,
            segment: nil,
            membership: nil,
            applied_gsn: 0,
            applied_actions: 0

  @doc """
  Opens an index over a fresh (or existing) segment directory.

  ## Options

    - `:dir` — directory holding the segment; a fresh temp dir by default
    - `:prewrite_bytes` — zero-fill this many bytes into the segment before
      any append, so every record lands inside already-written blocks. That is
      the "recycled segment" block state D3 measured at 960 µs per b100 window;
      without it every append also pays block allocation and an inode-size
      change. `0` (the default) appends into a sparse file.
  """
  @spec open(keyword()) :: t()
  def open(opts \\ []) do
    # `Segment.open/1` truncates at the last intact record, so the prewrite has
    # to come after it, never before.
    dir = Keyword.get_lazy(opts, :dir, &default_dir/0)
    File.mkdir_p!(dir)

    {:ok, segment, _repairs} = Segment.open(Path.join(dir, "00000001.seg"))
    segment = prewrite(segment, Keyword.get(opts, :prewrite_bytes, 0))

    %__MODULE__{
      tables: new_tables(Keyword.get(opts, :tag)),
      segment: segment,
      membership: MembershipIndex.new()
    }
  end

  @doc """
  Closes the segment. The ETS tables go with their owning process.
  """
  @spec close(t()) :: :ok
  def close(%__MODULE__{segment: segment}) do
    Segment.close(segment)
  end

  @doc """
  Appends `frames` (`cf_actions` stored values, one per Action) and returns
  after one `pwrite` and one `datasync`.

  The returned `t` and entries are what the caller acks with; passing them to
  `apply_window/2` is the consumer step. Nothing is written to ETS here.

  ## Options

    - `:sync` — `false` drops the `datasync`, for a setup append whose
      durability is not under test
  """
  @spec append_window(t(), [binary()], keyword()) :: {:ok, t(), [entry()]} | {:error, term()}
  def append_window(%__MODULE__{} = index, frames, opts \\ []) when is_list(frames) do
    base = (Segment.tail(index.segment) || 0) + 1
    offset = index.segment.offset
    header = Segment.header_size()

    entries =
      frames
      |> Enum.with_index()
      |> Enum.map_reduce(offset, fn {body, position}, offset ->
        entry = %{kind: :action_batch, gsn: base + position, body: body, offset: offset}
        {entry, offset + header + byte_size(body)}
      end)
      |> elem(0)

    records = Enum.map(entries, &Map.take(&1, [:kind, :gsn, :body]))

    case Segment.append(index.segment, records, Keyword.get(opts, :sync, true)) do
      {:ok, segment} -> {:ok, %{index | segment: segment}, entries}
      {:error, reason} -> {:error, reason}
    end
  end

  @doc """
  The consumer step: derives every read model from `entries`, in order.

  Entries may be a window's worth or a replay's page; applying the same
  records twice is a no-op for reads (GSN-stamped, monotonic `last_gsn`).
  """
  @spec apply_window(t(), [entry()]) :: t()
  def apply_window(%__MODULE__{} = index, entries) do
    Enum.reduce(entries, index, &apply_entry(&2, &1))
  end

  @doc """
  Appends and immediately applies — the shape a test or a rebuild wants, not
  the shape an ack path uses.
  """
  @spec append_and_apply(t(), [binary()], keyword()) :: {:ok, t()} | {:error, term()}
  def append_and_apply(%__MODULE__{} = index, frames, opts \\ []) do
    with {:ok, index, entries} <- append_window(index, frames, opts) do
      {:ok, apply_window(index, entries)}
    end
  end

  @doc """
  Drops every derived table and replays the segment into it.

  This is the whole recovery story for the read models: they are caches, and
  discarding them costs one pass over the log. Reopening the segment also
  runs D1's torn-tail repair, so a crash mid-append leaves exactly the intact
  prefix to replay.
  """
  @spec rebuild(t(), keyword()) :: {:ok, t(), map()}
  def rebuild(%__MODULE__{} = index, opts \\ []) do
    page = Keyword.get(opts, :page, 1_000)

    Segment.close(index.segment)
    reset_tables(index.tables)

    started = now()
    {:ok, segment, repairs} = Segment.open(index.segment.path)
    scanned = now()

    index = %{
      index
      | segment: segment,
        membership: MembershipIndex.new(),
        applied_gsn: 0,
        applied_actions: 0
    }

    last = Segment.tail(segment) || 0
    index = replay_pages(index, 1, last, page, 0)

    finished = now()

    {:ok, index,
     %{
       records: index.applied_actions,
       scan_us: scanned - started,
       replay_us: finished - scanned,
       total_us: finished - started,
       repairs: repairs
     }}
  end

  @doc """
  The materialised row for `entity_id` plus the log position it reflects.

  `:not_found` covers both "never written" and "tombstoned", which is the
  answer `EntityStore.get/3` gives for a deleted row.
  """
  @spec entity_state(t(), String.t()) :: {:ok, map()} | :not_found
  def entity_state(%__MODULE__{tables: tables}, entity_id) do
    case :ets.lookup(tables.entities, entity_id) do
      [{^entity_id, :live, model, fields, components, groups, last_gsn}] ->
        {:ok,
         %{
           id: entity_id,
           model: model,
           fields: fields,
           components: components,
           groups: groups,
           last_gsn: last_gsn
         }}

      _ ->
        :not_found
    end
  end

  @doc """
  A bounded catch-up page for `group_id`: up to `limit` Actions with a GSN
  greater than or equal to `from_gsn`, ascending, each read out of the log.

  The returned `:source` says which read served the page: `:offsets` for the
  dense offset index, `:sparse` when the caller asked for `Segment.read/2`.
  The benchmark measures both, because that is the difference between "the log
  is readable in pages" and "the log is readable in order only".
  """
  @spec updates_for_group(t(), String.t(), non_neg_integer(), pos_integer(), keyword()) ::
          {:ok, [map()]}
  def updates_for_group(%__MODULE__{} = index, group_id, from_gsn, limit, opts \\ []) do
    source = Keyword.get(opts, :read, :offsets)

    index
    |> group_gsns(group_id, from_gsn, limit)
    |> Enum.flat_map(fn gsn ->
      case read_record(index, gsn, source) do
        {:ok, record} -> [ActionFormat.decode(record.body, gsn)]
        :not_found -> []
      end
    end)
    |> then(&{:ok, &1})
  end

  @doc """
  The page's GSNs from the group index alone, ascending from `from_gsn`
  (inclusive), bounded by `limit`.
  """
  @spec group_gsns(t(), String.t(), non_neg_integer(), pos_integer()) :: [pos_integer()]
  def group_gsns(%__MODULE__{tables: tables}, group_id, from_gsn, limit) do
    start = {group_id, from_gsn}

    if :ets.member(tables.group_actions, start) and limit > 0,
      do: [from_gsn | take_gsns(tables.group_actions, group_id, start, limit - 1, [])],
      else: take_gsns(tables.group_actions, group_id, start, limit, [])
  end

  defp take_gsns(_table, _group_id, _key, 0, acc), do: Enum.reverse(acc)

  # `{group_id, gsn}` keys are contiguous in term order, so the first key of
  # another group ends the page.
  defp take_gsns(table, group_id, key, left, acc) do
    case :ets.next(table, key) do
      :"$end_of_table" -> Enum.reverse(acc)
      {^group_id, gsn} = next -> take_gsns(table, group_id, next, left - 1, [gsn | acc])
      {_other_group, _gsn} -> Enum.reverse(acc)
    end
  end

  @doc """
  The dedup fast path: the GSN an already-committed `action_id` landed at.
  """
  @spec action_by_id(t(), String.t()) :: {:ok, pos_integer()} | :not_found
  def action_by_id(%__MODULE__{tables: tables}, action_id) do
    case :ets.lookup(tables.by_action_id, action_id) do
      [{^action_id, gsn}] -> {:ok, gsn}
      [] -> :not_found
    end
  end

  @doc """
  The existence index `cf_component_entities` becomes: is `entity_id` a live
  row under `model` (when `component` is `nil`) or holding `component`?

  `component` is the full `<model>/<field>` name, matching the stored index's
  component entries.
  """
  @spec exists?(t(), String.t(), String.t() | nil, String.t()) :: boolean()
  def exists?(%__MODULE__{tables: tables}, model, component, entity_id) do
    :ets.member(tables.existence, {model, component, entity_id})
  end

  @doc """
  The consumer's position against the log tail.
  """
  @spec stats(t()) :: map()
  def stats(%__MODULE__{} = index) do
    %{
      log_tail: Segment.tail(index.segment) || 0,
      applied_gsn: index.applied_gsn,
      applied_actions: index.applied_actions,
      lag: (Segment.tail(index.segment) || 0) - index.applied_gsn
    }
  end

  @doc """
  Bytes held by the ETS read models, plus the consumer's own state counters.

  `:ets` reports table memory in words. It does not count large off-heap
  binaries, because ETS shares refc binaries instead of copying them, and it
  does not count the consumer's `MembershipIndex` map at all — that lives in
  the consumer's heap. `EbbServer.Bench.MemoryIndexDiff` reports the
  `:erlang.memory` delta beside this for those two reasons.
  """
  @spec memory(t()) :: map()
  def memory(%__MODULE__{} = index) do
    words = 8

    per_table =
      Map.new(@tables, fn table ->
        {table, :ets.info(index.tables[table], :memory) * words}
      end)

    membership = MembershipIndex.stats(index.membership)

    %{
      per_table: per_table,
      tables: per_table |> Map.values() |> Enum.sum(),
      membership_keys: membership.keys,
      membership_versions: membership.versions,
      entities: :ets.info(index.tables.entities, :size),
      applied: index.applied_actions,
      group_refs: :ets.info(index.tables.group_actions, :size),
      existence: :ets.info(index.tables.existence, :size)
    }
  end

  @doc """
  Builds the stored frame for one Action — what a Writer would hand the log.

  `update_scopes` is the per-Update group list the Writer persists. It is an
  argument rather than a derivation because it is claimed at admission, not
  read off the entity: §7 keeps it in the frame for exactly that reason.
  """
  @spec frame(map(), [[String.t()]]) :: binary()
  def frame(action, update_scopes) do
    action
    |> ActionFormat.build()
    |> ActionFormat.encode()
    |> ActionFormat.frame(update_scopes)
  end

  ## Consumer

  defp apply_entry(index, %{gsn: gsn, body: body, offset: offset}) do
    action = ActionFormat.decode(body, gsn)
    tables = index.tables

    :ets.insert(tables.offsets, {gsn, offset})
    :ets.insert(tables.by_action_id, {action["id"], gsn})
    insert_group_refs(tables.group_actions, action)

    membership = MembershipIndex.apply_action(index.membership, gsn, action["updates"])
    project_entities(tables, gsn, action["updates"], membership)

    %{
      index
      | membership: membership,
        applied_gsn: max(index.applied_gsn, gsn),
        applied_actions: index.applied_actions + 1
    }
  end

  # The scope snapshot in the record is the delivery contract: an Action whose
  # Updates fan out to the same group appears once in that group's GSN list.
  defp insert_group_refs(table, action) do
    action
    |> Map.get("update_scopes", [])
    |> Enum.flat_map(& &1)
    |> Enum.uniq()
    |> Enum.each(fn group_id -> :ets.insert(table, {{group_id, action["gsn"]}, true}) end)
  end

  # One row read and one row write per entity the Action touches, however many
  # of its Updates name that entity.
  defp project_entities(tables, gsn, updates, membership) do
    {by_entity, order} =
      Enum.reduce(updates, {%{}, []}, fn update, {by_entity, order} ->
        entity_id = update["subject_id"]

        if Map.has_key?(by_entity, entity_id),
          do: {Map.update!(by_entity, entity_id, &(&1 ++ [update])), order},
          else: {Map.put(by_entity, entity_id, [update]), [entity_id | order]}
      end)

    refreshed =
      for entity_id <- Enum.reverse(order) do
        write_entity(tables, gsn, entity_id, by_entity[entity_id], membership)
        membership_entity_ids(by_entity[entity_id], membership, gsn)
      end

    refresh_groups(tables, gsn, refreshed |> List.flatten() |> Enum.uniq(), membership)
  end

  # A membership row names the entity it files, so a change to the row changes
  # that entity's group set even though no Update in the Action names it.
  defp membership_entity_ids(updates, membership, gsn) do
    updates
    |> Enum.flat_map(fn update ->
      cond do
        membership_component?(update) ->
          entity_of_membership(membership, update["subject_id"], gsn)

        update["method"] == "delete" ->
          case MembershipIndex.get_before(membership, {:membership, update["subject_id"]}, gsn) do
            {entity_id, _group_id} when is_binary(entity_id) -> [entity_id]
            _ -> []
          end

        true ->
          []
      end
    end)
  end

  defp membership_component?(update) do
    is_binary(update["component"]) and Component.model(update["component"]) == "entityGroup"
  end

  defp entity_of_membership(membership, row_id, gsn) do
    case MembershipIndex.get(membership, {:membership, row_id}, gsn) do
      {entity_id, _group_id} when is_binary(entity_id) -> [entity_id]
      _ -> []
    end
  end

  defp refresh_groups(tables, gsn, entity_ids, membership) do
    for entity_id <- entity_ids do
      case :ets.lookup(tables.entities, entity_id) do
        [{^entity_id, status, model, fields, components, groups, last_gsn}] ->
          resolved = groups_at(membership, entity_id, gsn)

          if resolved != groups,
            do:
              :ets.insert(
                tables.entities,
                {entity_id, status, model, fields, components, resolved, last_gsn}
              )

        [] ->
          :ok
      end
    end
  end

  defp write_entity(tables, gsn, entity_id, updates, membership) do
    before = current_row(tables.entities, entity_id)

    row =
      Enum.reduce(updates, before, fn update, row ->
        case update["method"] do
          "delete" -> %{row | status: :deleted, last_gsn: gsn}
          "drop" -> drop_field(row, update, gsn)
          _ -> put_field(row, update, gsn)
        end
      end)

    groups = groups_at(membership, entity_id, gsn)
    row = %{row | groups: groups, last_gsn: max(row.last_gsn, gsn)}

    :ets.insert(
      tables.entities,
      {entity_id, row.status, row.model, row.fields, row.components, row.groups, row.last_gsn}
    )

    index_existence(tables.existence, entity_id, before, row)
  end

  defp current_row(table, entity_id) do
    case :ets.lookup(table, entity_id) do
      [{^entity_id, status, model, fields, components, groups, last_gsn}] ->
        %{
          status: status,
          model: model,
          fields: fields,
          components: components,
          groups: groups,
          last_gsn: last_gsn
        }

      [] ->
        %{
          status: :live,
          model: nil,
          fields: %{},
          components: [],
          groups: [],
          last_gsn: 0
        }
    end
  end

  # The merge is the wire's own LWW rule, so a reader cannot disagree with the
  # SQLite materializer about which value stands.
  defp put_field(row, update, gsn) do
    {model, field} = Component.split(update["component"])
    incoming = FieldMerge.stamp(update["data"], update["id"])
    fields = Map.update(row.fields, field, incoming, &FieldMerge.merge(&1, incoming))
    model = row.model || model

    %{
      row
      | fields: fields,
        model: model,
        components: component_names(fields, model),
        status: :live,
        last_gsn: max(row.last_gsn, gsn)
    }
  end

  defp drop_field(row, update, gsn) do
    fields = Map.delete(row.fields, Component.field(update["component"]))

    %{row | fields: fields, components: component_names(fields, row.model), last_gsn: gsn}
  end

  # Sorted, like `data.components`: two materializers that converged on the same
  # fields must agree on the canonical list.
  defp component_names(fields, model) when is_binary(model) do
    fields |> Map.keys() |> Enum.sort() |> Enum.map(&(model <> "/" <> &1))
  end

  defp component_names(_fields, _model), do: []

  # `cf_component_entities` is one entry per component plus one model entry per
  # row, which is exactly what `EntityTypeCache` resolves. Only the components
  # an Action added or removed are touched, so a put of one field costs one
  # entry rather than a rewrite of the row's whole index.
  defp index_existence(table, entity_id, before, row) do
    added =
      if before.status == :live, do: row.components -- before.components, else: row.components

    removed =
      if row.status == :live, do: before.components -- row.components, else: before.components

    for component <- removed,
        is_binary(before.model),
        do: :ets.delete(table, {before.model, component, entity_id})

    if is_binary(before.model) and (row.status != :live or before.model != row.model),
      do: :ets.delete(table, {before.model, nil, entity_id})

    if row.status == :live and is_binary(row.model) do
      :ets.insert(table, {{row.model, nil, entity_id}, true})

      for component <- added,
          do: :ets.insert(table, {{row.model, component, entity_id}, true})
    end
  end

  # Reads `MembershipIndex` through its public accessors and the key shapes its
  # moduledoc documents. Deriving the row set again here is what D2's corpus
  # found two bugs in, so the derivation stays in one module.
  defp groups_at(membership, entity_id, gsn) do
    membership
    |> MembershipIndex.get({:rows, entity_id}, gsn)
    |> List.wrap()
    |> Enum.flat_map(fn row_id ->
      case MembershipIndex.get(membership, {:membership, row_id}, gsn) do
        {_entity_id, group_id} when is_binary(group_id) -> [group_id]
        _ -> []
      end
    end)
    |> Enum.uniq()
  end

  ## Replay

  defp replay_pages(index, from, last, _page, _offset) when from > last, do: index

  defp replay_pages(index, from, last, page, offset) do
    to = min(from + page - 1, last)
    {:ok, records} = Segment.read_range(index.segment, from, to)

    {entries, next_offset} =
      Enum.map_reduce(records, offset, fn record, offset ->
        {Map.put(record, :offset, offset),
         offset + Segment.header_size() + byte_size(record.body)}
      end)

    index = apply_window(index, entries)
    replayed = from + length(records)

    if replayed > to,
      do: replay_pages(index, replayed, last, page, next_offset),
      else: index
  end

  ## Records

  defp read_record(index, gsn, :offsets) do
    case :ets.lookup(index.tables.offsets, gsn) do
      [{^gsn, offset}] -> read_at(index.segment.fd, offset)
      [] -> :not_found
    end
  end

  defp read_record(index, gsn, :sparse), do: Segment.read(index.segment, gsn)

  # The same header/body split `Segment` uses, re-verified: an offset index is
  # a cache, and a page read must not hand back a body the CRC rejects.
  defp read_at(fd, offset) do
    case :file.pread(fd, offset, Segment.header_size()) do
      {:ok,
       <<_magic::binary-size(4), kind, gsn::unsigned-64, len::unsigned-32, crc::unsigned-32>>} ->
        case :file.pread(fd, offset + Segment.header_size(), len) do
          {:ok, body} when byte_size(body) == len ->
            if :erlang.crc32(body) == crc,
              do: {:ok, %{kind: kind, gsn: gsn, body: body}},
              else: :not_found

          _ ->
            :not_found
        end

      _ ->
        :not_found
    end
  end

  ## Tables

  defp new_tables(tag) do
    unique = tag || System.unique_integer([:positive])

    Map.new(@tables, fn table ->
      options = [:named_table, :public, {:read_concurrency, true}]
      options = if table == :group_actions, do: [:ordered_set | options], else: [:set | options]
      {table, :ets.new(:"ebb_mi_#{table}_#{unique}", options)}
    end)
  end

  defp reset_tables(tables) do
    Enum.each(tables, fn {_table, tid} -> :ets.delete_all_objects(tid) end)
  end

  # The segment's blocks are written before the measured window, which is the
  # block state D3's recycled arm measured; `Segment.open/1` truncates to the
  # last intact record, so the prewrite has to come after it.
  defp prewrite(segment, 0), do: segment

  defp prewrite(%{fd: fd} = segment, bytes) do
    chunk = :binary.copy(<<0>>, 1024 * 1024)
    chunks = div(bytes, byte_size(chunk))

    Enum.each(0..(chunks - 1), fn i -> :ok = :file.pwrite(fd, i * byte_size(chunk), chunk) end)
    :ok = :file.datasync(fd)
    segment
  end

  defp default_dir do
    Path.join(System.tmp_dir!(), "ebb_mi_#{System.unique_integer([:positive])}")
  end

  defp now, do: System.monotonic_time(:microsecond)
end
