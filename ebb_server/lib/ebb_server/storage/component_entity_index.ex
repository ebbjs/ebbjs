defmodule EbbServer.Storage.ComponentEntityIndex do
  @moduledoc """
  The `cf_component_entities` index: its two key kinds and the ops that
  maintain them.

  One column family answers two questions:

    - **model entries**, `(model, 0x00, entity_id)` — every row committed
      under a model, whichever optional components it carries. This is what
      `EbbServer.Storage.EntityTypeCache` resolves id → model from at boot and
      for a delete, and what `SystemCache.populate_type/6` scans.
    - **component entries**, `(component, 0x00, entity_id)` where the
      component is `<model>/<field>` — the components a row's writes have put.
      The range is the existence candidate set; a row `delete` leaves its
      entries behind, so the reader filters liveness.

  The key shapes cannot collide: a model name never contains `/`, a component
  name always contains exactly one.

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
  those in order so the last write wins and the batch carries one RocksDB op
  per key.
  """

  alias EbbServer.Storage.RocksDB

  @typedoc """
  One not-yet-deduplicated index write. `:put` creates the entry, `:delete`
  removes it; the key is already encoded.
  """
  @type op :: {:put | :delete, binary()}

  @doc """
  The component entries one Action's Updates imply, in wire order.
  """
  @spec update_ops([map()]) :: [op()]
  def update_ops(updates), do: Enum.flat_map(updates, &update_op/1)

  defp update_op(%{method: method, component: component, subject_id: subject_id})
       when method in [:merge, :replace] and is_binary(component) do
    [{:put, RocksDB.encode_component_entity_key(component, subject_id)}]
  end

  defp update_op(%{method: :drop, component: component, subject_id: subject_id})
       when is_binary(component) do
    [{:delete, RocksDB.encode_component_entity_key(component, subject_id)}]
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
      {model, subject_id} -> [{:put, RocksDB.encode_component_entity_key(model, subject_id)}]
    end)
  end

  @doc """
  Reduces ordered ops to one per key, last write winning.

  The result is sorted by key so a batch is reproducible. A key that is put
  and then deleted disappears; one that is deleted and then put is present.
  """
  @spec reduce_ops([op()]) :: [op()]
  def reduce_ops(ops) do
    ops
    |> Enum.reduce(%{}, fn {op, key}, acc -> Map.put(acc, key, op) end)
    |> Enum.sort_by(fn {key, _op} -> key end)
    |> Enum.map(fn {key, op} -> {op, key} end)
  end

  @doc """
  Turns reduced ops into `RocksDB.write_batch/2` operations.
  """
  @spec batch_ops([op()], RocksDB.cf_ref()) :: [
          {:put, RocksDB.cf_ref(), binary(), binary()} | {:delete, RocksDB.cf_ref(), binary()}
        ]
  def batch_ops(ops, cf) do
    Enum.map(ops, fn
      {:put, key} -> {:put, cf, key, <<>>}
      {:delete, key} -> {:delete, cf, key}
    end)
  end

  @doc """
  Reduces a flush's per-Action op lists, newest first (the order a cons
  accumulator holds them), to one batch op per key.
  """
  @spec reduce_batch_ops([[op()]], RocksDB.cf_ref()) :: [
          {:put, RocksDB.cf_ref(), binary(), binary()} | {:delete, RocksDB.cf_ref(), binary()}
        ]
  def reduce_batch_ops(op_lists, cf) do
    op_lists
    |> Enum.reverse()
    |> :lists.append()
    |> reduce_ops()
    |> batch_ops(cf)
  end

  @doc """
  The ids with an entry for `component`, ascending: one prefix range of the
  index.

  An entry is a **candidate**, not an existence answer. A `delete` names the
  row and cannot know which components to detach, so it leaves the row's
  component entries behind; a tombstoned row therefore stays in this range.
  The row-level tombstone is the final filter — `SQLite.query_component_ids/2`
  joins `deleted_hlc IS NULL`, and the client replica filters liveness at
  read time. The model entry is what survives a delete as the row's
  fail-closed existence signal; component entries do not carry that duty.
  """
  @spec component_entry_ids(String.t(), keyword()) :: [String.t()]
  def component_entry_ids(component, opts \\ []) do
    name = Keyword.get(opts, :name, RocksDB)
    prefix = component <> <<0>>
    offset = byte_size(prefix)

    name
    |> RocksDB.cf_component_entities()
    |> RocksDB.prefix_iterator(prefix, name: name)
    |> Enum.map(fn {key, _value} -> binary_part(key, offset, byte_size(key) - offset) end)
  end
end
