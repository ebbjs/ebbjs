defmodule EbbServer.Storage.ComponentEntityIndex do
  @moduledoc """
  The derived component existence index and the ops that maintain it.

  One in-memory index answers two questions:

    - **model entries**, `(model, entity_id)` — every row committed under a
      model, whichever optional components it carries. This is what
      `EbbServer.Storage.EntityTypeCache` resolves id → model from at boot and
      for a delete, and the range `SystemCache.populate_type/6` scans.
    - **component entries**, `(component, entity_id)` where the component is
      `<model>/<field>` — the components a row's writes have put. The range is
      the existence candidate set; a row `delete` leaves its entries behind,
      so the reader filters liveness.

  Model names and component names cannot collide: a model name never contains
  `/`, a component name always contains exactly one.

  The index is **derived state**. It is not fsynced: the Writer applies its
  ops once the Action's range is durable, and `SystemCache` reconstructs it
  from `cf_actions` on every boot. Greenfield is allowed (#793 decision 9), so
  there is no column family to convert or migrate.

  A process death between the durable commit and that apply leaves the index
  missing the range until the storage tree rebuilds (the apply failure path
  escalates, and a Writer-only restart does not re-apply). Boot is its only
  reader today; #805 and #820 add readers and must preserve that invariant or
  make the restart reconcile.

  ## Keys are encoded for the resident set

  A label is interned to a small integer once, and an entry is stored as
  `{{label_id, entity_id}, <<>>}` in one `:ordered_set`. The id is kept whole
  because readers return it; the label is not repeated per entry, which is
  what keeps a row with k components within the resident-set gate (#849).
  Interning a label is a write-side decision, so a reader never inserts one.

  ## Writes follow the wire

  For each Update of an Action, in order: `merge` and `replace` put the
  component entry, `drop` deletes it, and `delete` writes no component entry
  because it names the row and cannot know which components to detach. The
  model entry is put once per folded subject, including for a delete, so a
  tombstoned row keeps its existence signal. That is why a delete leaves the
  row's component entries behind: they are candidates for an existence query
  and the row-level tombstone is the liveness filter (see
  `component_entry_ids/2`).

  A coalesced flush may put and delete the same key in different Actions, and
  one Action may drop and re-write the same component. `reduce_ops/1` folds
  those in order so the last write wins and the batch carries one write per
  key.
  """

  use GenServer

  @default_table :ebb_component_entities
  @default_labels :ebb_component_entity_labels
  @tables_key {__MODULE__, :tables}
  @labels_counter :"$counter"
  @select_chunk 1_000

  @typedoc """
  One not-yet-deduplicated index write: a `(label, entity_id)` key to create
  or remove. The label is a model name or a `<model>/<field>` component name.
  """
  @type op :: {:put | :delete, {String.t(), String.t()}}

  # ---------------------------------------------------------------------------
  # Table lifecycle
  # ---------------------------------------------------------------------------

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

  @doc """
  The `{entries, labels}` table pair for the given overrides, defaulting to
  the instance this process tree started.

  Callers that override one name should override both; a lone name falls back
  to the other half of the live instance.
  """
  @spec tables(keyword()) :: {atom(), atom()}
  def tables(opts \\ []) do
    case {Keyword.get(opts, :component_index), Keyword.get(opts, :component_entity_labels)} do
      {nil, nil} ->
        :persistent_term.get(@tables_key, {@default_table, @default_labels})

      {entries, labels} ->
        {entries || @default_table, labels || @default_labels}
    end
  end

  @doc """
  Clears both tables, creating them if the caller has no started instance.
  """
  @spec reset(keyword()) :: :ok
  def reset(opts \\ []) do
    {entries, labels} = create_tables(opts)
    :ets.delete_all_objects(entries)
    :ets.delete_all_objects(labels)
    :ok
  end

  @doc """
  Number of entries currently held. Tests use it to pin the op plan; the
  resident-set bench reads the tables directly.
  """
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

  # ---------------------------------------------------------------------------
  # Op plan
  # ---------------------------------------------------------------------------

  @doc """
  The component entries one Action's Updates imply, in wire order.
  """
  @spec update_ops([map()]) :: [op()]
  def update_ops(updates), do: Enum.flat_map(updates, &update_op/1)

  defp update_op(%{method: method, component: component, subject_id: subject_id})
       when method in [:merge, :replace] and is_binary(component) do
    [{:put, {component, subject_id}}]
  end

  defp update_op(%{method: :drop, component: component, subject_id: subject_id})
       when is_binary(component) do
    [{:delete, {component, subject_id}}]
  end

  # A delete names the row, so the components it detaches are unknown.
  defp update_op(_update), do: []

  @doc """
  One Action's index writes: a component entry per value Update (unless
  `components: false`, the bench-only split), then one model entry per folded
  subject.
  """
  @spec action_ops([map()], [{String.t() | nil, String.t()}], keyword()) :: [op()]
  def action_ops(updates, model_entries, opts \\ []) do
    component_ops =
      if Keyword.get(opts, :components, true), do: update_ops(updates), else: []

    component_ops ++ model_ops(model_entries)
  end

  @doc """
  One model entry per folded subject, skipping a subject the fold could not
  resolve a model for.

  `entries` is `{model | nil, entity_id}` per subject, in first-appearance
  order.
  """
  @spec model_ops([{String.t() | nil, String.t()}]) :: [op()]
  def model_ops(entries) do
    Enum.flat_map(entries, fn
      {nil, _subject_id} -> []
      {model, subject_id} -> [{:put, {model, subject_id}}]
    end)
  end

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

  @doc """
  Reduces a flush's per-Action op lists, in GSN order, to one write per key.
  """
  @spec reduce_batch_ops([[op()]]) :: [op()]
  def reduce_batch_ops(op_lists) do
    op_lists
    |> :lists.append()
    |> reduce_ops()
  end

  # ---------------------------------------------------------------------------
  # Store
  # ---------------------------------------------------------------------------

  @doc """
  Applies ordered ops. Last write wins across the list.
  """
  @spec apply_ops([op()], keyword()) :: :ok
  def apply_ops(ops, opts \\ []) do
    {entries, labels} = tables(opts)

    Enum.each(ops, fn
      {:put, {label, entity_id}} ->
        :ets.insert(entries, {{label_id(labels, label), entity_id}, <<>>})

      {:delete, {label, entity_id}} ->
        case :ets.lookup(labels, label) do
          [{_, label_id}] -> :ets.delete(entries, {label_id, entity_id})
          [] -> :ok
        end
    end)
  end

  @doc """
  The ids with an entry for `component`, ascending: one index range.

  An entry is a **candidate**, not an existence answer. A `delete` names the
  row and cannot know which components to detach, so it leaves the row's
  component entries behind; a tombstoned row therefore stays in this range.
  The row-level tombstone is the final filter — `SQLite.query_component_ids/2`
  joins `deleted_hlc IS NULL`, and the client replica filters liveness at
  read time. The model entry is what survives a delete as the row's
  fail-closed existence signal; component entries do not carry that duty.
  """
  @spec component_entry_ids(String.t(), keyword()) :: [String.t()]
  def component_entry_ids(component, opts \\ []), do: collect_component_entry_ids(component, opts)

  @doc """
  Calls `fun` with each id for `component`, one bounded chunk at a time.

  Boot's per-type walk uses this so a large model does not build its whole id
  list before materializing a row.
  """
  @spec each_component_entry_id(String.t(), (String.t() -> any()), keyword()) :: :ok
  def each_component_entry_id(component, fun, opts \\ []) do
    {entries, labels} = tables(opts)

    case :ets.lookup(labels, component) do
      [] ->
        :ok

      [{_, label_id}] ->
        select_each(entries, [{{{label_id, :"$1"}, :_}, [], [:"$1"]}], fun)
    end
  end

  defp collect_component_entry_ids(component, opts) do
    {entries, labels} = tables(opts)

    case :ets.lookup(labels, component) do
      [] ->
        []

      [{_, label_id}] ->
        entries
        |> :ets.select([{{{label_id, :"$1"}, :_}, [], [:"$1"]}])
        |> Enum.sort()
    end
  end

  defp select_each(entries, spec, fun) do
    case :ets.select(entries, spec, @select_chunk) do
      :"$end_of_table" ->
        :ok

      {ids, continuation} ->
        Enum.each(ids, fun)
        select_each_cont(continuation, fun)
    end
  end

  defp select_each_cont(continuation, fun) do
    case :ets.select(continuation) do
      :"$end_of_table" ->
        :ok

      {ids, continuation} ->
        Enum.each(ids, fun)
        select_each_cont(continuation, fun)
    end
  end

  # The counter row makes id allocation atomic, so two processes interning
  # different labels can never share an id even if a caller races the boot
  # replay. A loser of the same-label race consumes an id and then takes the
  # winner's, which only leaves a gap.
  defp label_id(labels, label) do
    case :ets.lookup(labels, label) do
      [{_, id}] -> id
      [] -> intern_label(labels, label)
    end
  end

  defp intern_label(labels, label) do
    id = :ets.update_counter(labels, @labels_counter, {2, 1}, {@labels_counter, 0})

    if :ets.insert_new(labels, {label, id}) do
      id
    else
      label_id(labels, label)
    end
  end
end
