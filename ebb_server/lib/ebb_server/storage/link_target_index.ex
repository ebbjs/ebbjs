defmodule EbbServer.Storage.LinkTargetIndex do
  @moduledoc """
  The derived incoming-edge index and the ops that maintain it.

  `ebb/link` is a keyed component of its source row (decision 13 in
  `docs/adr/0001-component-model.md`), so forward traversal — "what does this
  row point at?" — is a component read of the row itself. Incoming traversal
  — "which rows point at this target?" — is not answerable from the source
  rows, so it is this index: `(type, target_id) → source ids`.

  The key is derived from the component's **value**, never from its name:
  one component carries every edge of its source, so an entry names the
  `type`/`target_id` pair the value nests under, not the component
  `ebb/link`.

  ## Derived state

  The index has the same duty as `EbbServer.Storage.ComponentEntityIndex`
  and follows the same rules: it is not fsynced, the Writer applies its ops
  once the Action's range is durable, and `SystemCache` reconstructs it from
  `cf_actions` on every boot. Both write paths run the same
  `update_ops/1`, so a live index and a rebuilt one agree by construction.

  ## Entries are candidates

  An entry is a **candidate**, not an existence answer. A row `delete` names
  the row and cannot know which edges to detach, so it leaves the row's link
  entries behind exactly as it leaves its component entries; the row-level
  tombstone is the liveness filter. Neither does an `ebb/link` `drop` remove
  them, for the same reason: the dropped value it no longer carries is
  unknown.

  ## Writes follow the wire

  An edge's key is three levels deep — field, then type, then target id —
  and only the leaf carries presence. So `update_ops/1` walks an Update's
  value patch to that depth and reads each leaf: `value: nil` (the
  tombstone) is a removal, anything else is a presence.

  A patch that is not exactly that shape — a leaf where a level should be a
  map, or a level that is not a map at all — indexes **nothing**. A
  wholesale re-write of a field or a type subtree would need the entries it
  discards, which the patch does not restate, and guessing would index edges
  the row does not carry. The boot rebuild cannot recover one either: it
  replays the same log through this same function, so a malformed patch
  contributes nothing there too, and only a later well-formed write of the
  same keys adds the entries back. Fail-closed beats a wrong answer, and the
  write path the SDK emits is always three levels deep.
  `drop` and `delete` carry no patch at all, so they index nothing for the
  reason "entries are candidates" gives above.

  ## No reader yet

  `source_ids/3` has no caller in `lib/`: the server answers no incoming
  traversal — the client's replica owns that read, derived from the rows it
  materializes. The index is the derived state the schema-free server needs
  once a wire query asks "who points at this target?", built now because the
  slice that moves the edge onto its source is the slice that can build it
  from the same patch. Until a reader exists it costs one op per edge per
  Action and a second op list through every boot replay — the price
  `RelationshipCache` paid for the same information, kept as memory instead
  of a column family.

  ## Keys are encoded for the resident set

  A `type` label is interned to a small integer once and an entry is stored
  as `{{label_id, target_id, source_id}, <<>>}` in one `:ordered_set`. The
  type is the only repeated part: a source with many edges to one target
  still names that target whole, and a read for one target is one index
  range ordered by source. Interning a label is a write-side decision, so a
  reader never inserts one.
  """

  use GenServer

  alias EbbServer.Storage.SystemComponent

  @default_table :ebb_link_targets
  @default_labels :ebb_link_target_labels
  @tables_key {__MODULE__, :tables}
  @labels_counter :"$counter"

  @type op ::
          {:put | :delete, {type :: String.t(), target_id :: String.t(), source_id :: String.t()}}

  @doc false
  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  @impl true
  def init(opts) do
    tables = create_tables(opts)
    :persistent_term.put(@tables_key, tables)
    {:ok, %{tables: tables}}
  end

  @impl true
  def terminate(_reason, %{tables: {entries, labels}}) do
    delete_table(entries)
    delete_table(labels)
    :ok
  end

  # Override both names or neither: a lone override pairs with the live
  # instance's other table.
  @spec tables(keyword()) :: {atom(), atom()}
  def tables(opts \\ []) do
    case {Keyword.get(opts, :link_targets), Keyword.get(opts, :link_target_labels)} do
      {nil, nil} ->
        :persistent_term.get(@tables_key, {@default_table, @default_labels})

      {entries, labels} ->
        {entries || @default_table, labels || @default_labels}
    end
  end

  @spec reset(keyword()) :: :ok
  def reset(opts \\ []) do
    {entries, labels} = create_tables(opts)
    :ets.delete_all_objects(entries)
    :ets.delete_all_objects(labels)
    :ok
  end

  @spec size(keyword()) :: non_neg_integer()
  def size(opts \\ []) do
    {entries, _labels} = tables(opts)
    :ets.info(entries, :size)
  end

  defp create_tables(opts) do
    {entries, labels} = tables(opts)
    {ensure_table(entries, :ordered_set, read_concurrency: true), ensure_table(labels, :set, [])}
  end

  defp ensure_table(table, type, extra) do
    case :ets.info(table, :name) do
      :undefined ->
        :ets.new(table, [type, :public, :named_table] ++ extra)

      _ ->
        table
    end
  end

  defp delete_table(table) do
    :ets.delete(table)
  rescue
    ArgumentError -> :ok
  end

  @spec update_ops([map()]) :: [op()]
  def update_ops(updates), do: Enum.flat_map(updates, &update_op/1)

  defp update_op(%{
         method: method,
         component: component,
         subject_id: source_id,
         data: data
       })
       when method in [:merge, :replace] and is_binary(source_id) do
    if component == SystemComponent.component(:link) do
      data |> edge_leaves() |> Enum.map(&edge_op(&1, source_id))
    else
      []
    end
  end

  defp update_op(_update), do: []

  # `{value: nil}` is the wire's tombstone; a leaf that carries no `value`
  # key is not a leaf any writer produces, so it is malformed like the rest.
  defp edge_op({type, target_id, nil}, source_id), do: {:delete, {type, target_id, source_id}}
  defp edge_op({type, target_id, _present}, source_id), do: {:put, {type, target_id, source_id}}

  # The component's value nests `field → type → target_id → leaf`. Each
  # level is a wire map (`%{"map" => entries}`), and a single malformed node
  # drops the whole patch: partially indexing it would answer for a shape no
  # writer produced.
  defp edge_leaves(%{"map" => fields}) when is_map(fields) do
    fields
    |> Enum.reduce_while([], fn {_field, types}, acc ->
      case type_leaves(types) do
        {:ok, leaves} -> {:cont, acc ++ leaves}
        :error -> {:halt, :error}
      end
    end)
    |> case do
      :error -> []
      leaves -> leaves
    end
  end

  defp edge_leaves(_data), do: []

  defp type_leaves(%{"map" => types}) when is_map(types) do
    types
    |> Enum.reduce_while([], fn {type, targets}, acc ->
      case target_leaves(type, targets) do
        {:ok, leaves} -> {:cont, acc ++ leaves}
        :error -> {:halt, :error}
      end
    end)
    |> case do
      :error -> :error
      leaves -> {:ok, leaves}
    end
  end

  defp type_leaves(_types), do: :error

  defp target_leaves(type, %{"map" => targets}) when is_map(targets) do
    targets
    |> Enum.reduce_while([], fn
      {target_id, %{"value" => present}}, acc -> {:cont, [{type, target_id, present} | acc]}
      {_target_id, _not_a_leaf}, _acc -> {:halt, :error}
    end)
    |> case do
      :error -> :error
      leaves -> {:ok, leaves}
    end
  end

  defp target_leaves(_type, _targets), do: :error

  @doc """
  Reduces ordered ops to one per key, last write winning.

  Key order does not matter to `apply_ops/2`, which is last-wins per key, so
  the reduction does not sort. A key that is put and then deleted is a
  `:delete` in the result; applying it to an absent key is a no-op.
  """
  @spec reduce_ops([op()]) :: [op()]
  def reduce_ops(ops) do
    ops
    |> Enum.reduce(%{}, fn {op, key}, acc -> Map.put(acc, key, op) end)
    |> Enum.map(fn {key, op} -> {op, key} end)
  end

  @spec reduce_batch_ops([[op()]]) :: [op()]
  def reduce_batch_ops(op_lists) do
    op_lists
    |> :lists.append()
    |> reduce_ops()
  end

  @spec apply_ops([op()], keyword()) :: :ok
  def apply_ops(ops, opts \\ []) do
    {entries, labels} = tables(opts)

    Enum.each(ops, fn
      {:put, {type, target_id, source_id}} ->
        :ets.insert(entries, {{label_id(labels, type), target_id, source_id}, <<>>})

      {:delete, {type, target_id, source_id}} ->
        case :ets.lookup(labels, type) do
          [{_, label_id}] -> :ets.delete(entries, {label_id, target_id, source_id})
          [] -> :ok
        end
    end)
  end

  @doc """
  The ids of the rows carrying an edge of `type` to `target_id`, ascending.

  An entry is a **candidate**: a row `delete` leaves its entries behind, so
  the caller filters liveness against the row's own tombstone.
  """
  @spec source_ids(String.t(), String.t(), keyword()) :: [String.t()]
  def source_ids(type, target_id, opts \\ []) do
    {entries, labels} = tables(opts)

    case :ets.lookup(labels, type) do
      [] ->
        []

      [{_, label_id}] ->
        entries
        |> :ets.select([{{{label_id, target_id, :"$1"}, :_}, [], [:"$1"]}])
        |> Enum.sort()
    end
  end

  # The counter row makes id allocation atomic, so two processes interning
  # different labels can never share an id even if a caller races the boot
  # replay. A loser of the same-label race consumes an id and then takes the
  # winner's, which only leaves a gap.
  defp label_id(labels, type) do
    case :ets.lookup(labels, type) do
      [{_, id}] -> id
      [] -> intern_label(labels, type)
    end
  end

  defp intern_label(labels, type) do
    id = :ets.update_counter(labels, @labels_counter, {2, 1}, {@labels_counter, 0})

    if :ets.insert_new(labels, {type, id}) do
      id
    else
      label_id(labels, type)
    end
  end
end
