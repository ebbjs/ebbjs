defmodule EbbServer.Sync.FanOutRouter.Recovery do
  @moduledoc """
  Re-derives the pending fan-out work from the durable log.

  A `EbbServer.Sync.FanOutRouter` that restarts (or that missed a commit
  while it was down) resumes from its persisted pushed frontier. This
  module answers what is left to push: the committed GSN ranges above
  that frontier, and the group set each of those Actions belongs to.
  """

  alias EbbServer.Storage.RocksDB

  @doc """
  Re-derives the un-pushed committed GSN ranges in `[from, to]` and the
  group set each recovered Action belongs to, straight from the durable
  log.

  Called only when the persisted pushed frontier is behind the log (a
  Router restart or a commit that landed while the Router was down). Keys
  alone drive the range folding; the Router re-reads the Actions when it
  drains. The group scan is a full `cf_group_actions` pass so a group that
  gains a subscriber after the restart still receives the pending Action
  live.
  """
  @spec recover_committed(non_neg_integer(), non_neg_integer()) ::
          {[{non_neg_integer(), non_neg_integer()}], %{non_neg_integer() => [String.t()]}}
  def recover_committed(from, to) when from <= to do
    {committed_ranges(from, to), groups_by_gsn(from, to)}
  end

  defp committed_ranges(from, to) do
    cf = RocksDB.cf_actions()
    from_key = RocksDB.encode_gsn_key(from)
    to_key = RocksDB.encode_gsn_key(to + 1)

    RocksDB.range_iterator(cf, from_key, to_key)
    |> Stream.map(fn {key, _value} -> RocksDB.decode_gsn_key(key) end)
    |> Enum.reduce([], &fold_gsn_into_range/2)
    |> Enum.reverse()
  end

  # Present GSNs arrive in ascending order, so the range being built is
  # always at the head: extend it when the next GSN is contiguous, start
  # a new one across a hole.
  defp fold_gsn_into_range(gsn, [{range_from, range_to} | rest]) when gsn == range_to + 1 do
    [{range_from, gsn} | rest]
  end

  defp fold_gsn_into_range(gsn, acc), do: [{gsn, gsn} | acc]

  defp groups_by_gsn(from, to) do
    RocksDB.full_iterator(RocksDB.cf_group_actions())
    |> Stream.flat_map(fn {key, _value} ->
      case RocksDB.decode_group_action_key(key) do
        {group_id, gsn} when gsn >= from and gsn <= to -> [{group_id, gsn}]
        _ -> []
      end
    end)
    |> Enum.reduce(%{}, fn {group_id, gsn}, acc ->
      Map.update(acc, gsn, [group_id], &[group_id | &1])
    end)
    |> Map.new(fn {gsn, group_ids} ->
      {gsn, group_ids |> Enum.uniq() |> Enum.sort()}
    end)
  end
end
