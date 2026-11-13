defmodule EbbServer.Bench.WriteBatch do
  @moduledoc """
  Builds and commits the raw `write_batch` payload the t5 spike measures.

  The op list mirrors what `EbbServer.Storage.Writer` commits for one flush:
  per Action a `cf_actions` record plus its dedup and group-index rows, then
  one coalesced `cf_entity_actions` row per subject across the whole batch
  (keyed at that subject's highest GSN, holding its sorted GSN list), then
  there is no component-index op: that index is derived state, applied in
  memory after the durable range (#849), so it is not part of the raw batch.

  Everything is bench-only. There is no Writer, no cache mutation, no
  watermark advance, and no fan-out; only the NIF call is measured.

  This uses `EbbServer.Storage.ActionFormat` for the `cf_actions` value so the
  spike mirrors the production envelope without changing the write
  path. The tests pin the shape, so a format change has to update them.

  `--ablate` narrows the op set to the phases that name an op group —
  `:dedup` (drop `cf_action_dedup`), `:entity_actions` (drop
  `cf_entity_actions`), `:group_index` (drop `cf_group_actions`), and
  `:entity_index` as the alias that drops `cf_entity_actions`.
  Ablating every group leaves a `cf_actions`-only batch, which is the cheapest
  durable write an Action can have; the report prints the ablated phases so a narrowed run is
  never mistaken for the full shape.
  """

  alias EbbServer.Bench.{Options, Workbook}
  alias EbbServer.Storage.{ActionFormat, ActionValidator, RocksDB}

  # Each caller owns a disjoint GSN space far above the seeded Actions' GSNs.
  # Nothing claims from it and nothing scans across it, so a caller can never
  # collide with another caller or with the seeded data.
  @caller_gsn_base 1_000_000_000

  @doc """
  The first GSN of the `seq`-th call made by `caller_id`.
  """
  @spec gsn_start(pos_integer(), non_neg_integer()) :: pos_integer()
  def gsn_start(caller_id, seq), do: caller_id * @caller_gsn_base + seq

  @doc """
  Builds the complete op list for one call.

  Callers invoke this outside the measured region: Action construction,
  validation, ETF encoding, and every key are prepared here so the timed
  section holds only the `write_batch` NIF call.
  """
  @spec build_ops(Options.t(), map(), pos_integer(), non_neg_integer()) :: [
          {:put, term(), binary(), binary()}
        ]
  def build_ops(%Options{} = config, ctx, caller_id, seq),
    do: build_ops(config, ctx, caller_id, seq, gsn_start(caller_id, seq), &stored_frame/2)

  @doc """
  The production frame's `cf_actions` puts for one Action.

  Every Update here resolves to the single bench group, so the stored scopes
  are the same one-element list per Update.
  """
  @spec stored_frame(map(), non_neg_integer()) :: [{:put, term(), binary(), binary()}]
  def stored_frame(action, gsn) do
    update_scopes = Enum.map(action.updates, fn _ -> [Workbook.group_id()] end)
    payload = action |> ActionFormat.build() |> ActionFormat.encode()

    [
      {:put, RocksDB.cf_actions(), RocksDB.encode_gsn_key(gsn),
       ActionFormat.frame(payload, update_scopes)}
    ]
  end

  @doc """
  Builds the same op list for a flush at an explicit GSN start.

  Two things vary between the write benchmarks that share this op shape: the
  GSN window a flush lands in, and the stored `cf_actions` value. `gsn_start`
  is therefore passed rather than derived, and `stored` is a function from
  `(action, gsn)` to that Action's `cf_actions` puts — one for the production
  production frame, one per candidate shape in `EbbServer.Bench.Envelope.Shapes`. The
  rest of the batch is identical, which is what keeps the two benchmarks
  pricing the same flush.
  """
  @spec build_ops(
          Options.t(),
          map(),
          pos_integer(),
          non_neg_integer(),
          non_neg_integer(),
          (map(), non_neg_integer() -> [{:put, term(), binary(), binary()}])
        ) :: [{:put, term(), binary(), binary()}]
  def build_ops(%Options{} = config, ctx, caller_id, seq, gsn_start, stored) do
    {action_ops, subject_gsns} =
      0..(config.batch_size - 1)
      |> Enum.map_reduce(%{}, fn offset, subject_gsns ->
        action =
          config
          |> Workbook.build_action(ctx, caller_id, seq + offset)
          |> ActionValidator.to_validated_action()

        gsn = gsn_start + offset
        ops = stored.(action, gsn) ++ action_ops(action, gsn, config.ablate)

        {ops, accumulate_subject_gsns(action, gsn, subject_gsns, config.ablate)}
      end)

    :lists.append(action_ops) ++ entity_ops(subject_gsns, config.ablate)
  end

  defp accumulate_subject_gsns(action, gsn, subject_gsns, ablate) do
    if entity_actions_ablated?(ablate) do
      subject_gsns
    else
      Enum.reduce(action.updates, subject_gsns, fn update, acc ->
        Map.update(acc, update.subject_id, [gsn], &[gsn | &1])
      end)
    end
  end

  @doc """
  Creates a RocksDB batch holding `ops`.

  Kept separate from `commit/2` so batch assembly is not charged to the
  measured latency.
  """
  @spec batch([{:put, term(), binary(), binary()}]) :: term()
  def batch(ops) do
    {:ok, batch} = :rocksdb.batch()

    Enum.each(ops, fn {:put, cf, key, value} ->
      :ok = :rocksdb.batch_put(batch, cf, key, value)
    end)

    batch
  end

  @doc """
  Commits `batch` and returns the wall time of the `write_batch` NIF call.

  The latency spans only `:rocksdb.write_batch/3`; batch construction and
  release sit outside it. The batch is released whatever the outcome.
  """
  @spec commit(term(), boolean()) ::
          {:ok, non_neg_integer()} | {:error, non_neg_integer(), term()}
  def commit(batch, sync) do
    started = System.monotonic_time(:microsecond)

    try do
      case :rocksdb.write_batch(RocksDB.db_ref(), batch, sync: sync) do
        :ok ->
          {:ok, elapsed(started)}

        {:error, reason} ->
          {:error, elapsed(started), reason}
      end
    after
      :rocksdb.release_batch(batch)
    end
  end

  defp elapsed(started), do: System.monotonic_time(:microsecond) - started

  defp action_ops(action, gsn, ablate) do
    gsn_key = RocksDB.encode_gsn_key(gsn)

    dedup_ops(action, gsn_key, ablate) ++ group_ops(action, gsn, ablate)
  end

  defp dedup_ops(action, gsn_key, ablate) do
    if :dedup in ablate, do: [], else: [{:put, RocksDB.cf_action_dedup(), action.id, gsn_key}]
  end

  # The union of resolved groups is indexed once per Action, not once per
  # Update; here every Update resolves to the single bench group.
  defp group_ops(action, gsn, ablate) do
    if :group_index in ablate do
      []
    else
      key = RocksDB.encode_group_action_key(Workbook.group_id(), gsn)
      [{:put, RocksDB.cf_group_actions(), key, action.id}]
    end
  end

  defp entity_ops(subject_gsns, ablate) do
    if entity_actions_ablated?(ablate) do
      []
    else
      subject_gsns
      |> Enum.map(fn {subject_id, gsns} ->
        {key, value} = RocksDB.encode_entity_gsn_row(subject_id, gsns)
        {:put, RocksDB.cf_entity_actions(), key, value}
      end)
      |> Enum.sort_by(fn {:put, _cf, key, _value} -> key end)
    end
  end

  defp entity_actions_ablated?(ablate),
    do: :entity_actions in ablate or :entity_index in ablate
end
