defmodule EbbServer.Bench.WriteBatch do
  @moduledoc """
  Builds and commits the raw `write_batch` payload the t5 spike measures.

  The op list mirrors what `EbbServer.Storage.Writer` commits for one flush:
  per Action a `cf_actions` record plus its dedup and group-index rows and
  one `cf_entity_actions` row per Update, then one `cf_type_entities` row
  per distinct subject across the whole batch.

  Everything is bench-only. There is no Writer, no cache mutation, no
  watermark advance, and no fan-out; only the NIF call is measured.
  """

  alias EbbServer.Bench.{Options, Workbook}
  alias EbbServer.Storage.{ActionValidator, RocksDB}

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
  The contiguous GSN range one call writes.
  """
  @spec gsn_range(pos_integer(), non_neg_integer(), pos_integer()) :: Range.t()
  def gsn_range(caller_id, seq, batch_size) do
    start = gsn_start(caller_id, seq)
    start..(start + batch_size - 1)
  end

  @doc """
  Builds the complete op list for one call.

  Callers invoke this outside the measured region: Action construction,
  validation, ETF encoding, and every key are prepared here so the timed
  section holds only the `write_batch` NIF call.
  """
  @spec build_ops(Options.t(), map(), pos_integer(), non_neg_integer()) :: [
          {:put, term(), binary(), binary()}
        ]
  def build_ops(%Options{} = config, ctx, caller_id, seq) do
    start = gsn_start(caller_id, seq)

    {action_ops, type_keys} =
      0..(config.batch_size - 1)
      |> Enum.map_reduce(MapSet.new(), fn offset, keys ->
        action =
          config
          |> Workbook.build_action(ctx, caller_id, seq + offset)
          |> ActionValidator.to_validated_action()

        ops = action_ops(action, start + offset)
        {ops, MapSet.union(keys, type_keys(action))}
      end)

    :lists.append(action_ops) ++ type_entity_ops(type_keys)
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

  defp action_ops(action, gsn) do
    gsn_key = RocksDB.encode_gsn_key(gsn)
    update_scopes = Enum.map(action.updates, fn _ -> [Workbook.group_id()] end)

    [
      {:put, RocksDB.cf_actions(), gsn_key,
       :erlang.term_to_binary(storage_map(action, gsn, update_scopes))},
      {:put, RocksDB.cf_action_dedup(), action.id, gsn_key}
      | group_ops(action, gsn) ++ entity_ops(action, gsn)
    ]
  end

  # The union of resolved groups is indexed once per Action, not once per
  # Update; here every Update resolves to the single bench group.
  defp group_ops(action, gsn) do
    key = RocksDB.encode_group_action_key(Workbook.group_id(), gsn)
    [{:put, RocksDB.cf_group_actions(), key, action.id}]
  end

  defp entity_ops(action, gsn) do
    Enum.map(action.updates, fn update ->
      key = RocksDB.encode_entity_gsn_key(update.subject_id, gsn)
      {:put, RocksDB.cf_entity_actions(), key, action.id}
    end)
  end

  defp type_keys(action) do
    action.updates
    |> Enum.map(&RocksDB.encode_type_entity_key(&1.subject_type, &1.subject_id))
    |> MapSet.new()
  end

  # One put per unique key per batch, sorted for reproducible batches, like
  # the Writer's flush.
  defp type_entity_ops(type_keys) do
    type_keys
    |> Enum.sort()
    |> Enum.map(fn key -> {:put, RocksDB.cf_type_entities(), key, <<>>} end)
  end

  defp storage_map(action, gsn, update_scopes) do
    %{
      "id" => action.id,
      "actor_id" => action.actor_id,
      "hlc" => action.hlc,
      "gsn" => gsn,
      "update_scopes" => update_scopes,
      "updates" =>
        Enum.map(action.updates, fn update ->
          %{
            "id" => update.id,
            "subject_id" => update.subject_id,
            "subject_type" => update.subject_type,
            "method" => Atom.to_string(update.method),
            "data" => update.data
          }
        end)
    }
  end
end
