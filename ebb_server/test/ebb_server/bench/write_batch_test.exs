defmodule EbbServer.Bench.WriteBatchTest do
  @moduledoc """
  Pins the op batch the t5 spike commits: the same five column families the
  Writer touches per Action, one contiguous GSN range per call, and
  disjoint ranges between callers.

  Expected counts are written as literals derived from the canonical shape
  (100 Actions x 2 Updates, one group per Update) rather than recomputed
  from the module under test.
  """

  use ExUnit.Case, async: true

  alias EbbServer.Bench.{Options, Workbook, WriteBatch}
  alias EbbServer.Storage.{ActionFormat, RocksDB}

  setup do
    ctx = %{
      group_id: Workbook.group_id(),
      actor_id: Workbook.actor_id(),
      entities: Enum.map(1..10, &"todo_seed_#{&1}"),
      hot_entity_id: "todo_bench_hot",
      hot_membership_id: "eg_bench_hot",
      seeded_actions: 1
    }

    {:ok, ctx: ctx}
  end

  describe "GSN partitioning" do
    test "the next call starts after the previous call's batch_size GSNs" do
      assert WriteBatch.gsn_start(1, 0) == 1_000_000_000
      assert WriteBatch.gsn_start(1, 100) == 1_000_000_100
    end

    test "callers never share a GSN start" do
      starts = Enum.map([1, 2, 4], &WriteBatch.gsn_start(&1, 0))
      assert length(Enum.uniq(starts)) == 3
      assert Enum.min(starts) >= 1_000_000_000
    end
  end

  describe "build_ops/4 with --ablate" do
    test "ablating the op groups leaves a cf_actions-only batch", context do
      {:ok, config} =
        Options.parse([
          "--tier",
          "t5",
          "--batch-size",
          "100",
          "--distribution",
          "hot",
          "--ablate",
          "dedup,entity_index,group_index"
        ])

      ops = WriteBatch.build_ops(config, context.ctx, 1, 0)

      assert length(ops) == 100
      assert Enum.all?(ops, fn {:put, cf, _key, _value} -> cf == RocksDB.cf_actions() end)
    end

    test "ablating one group drops only that group's rows", context do
      {:ok, full} = Options.parse(["--tier", "t5", "--batch-size", "10", "--distribution", "hot"])

      {:ok, no_dedup} =
        Options.parse([
          "--tier",
          "t5",
          "--batch-size",
          "10",
          "--distribution",
          "hot",
          "--ablate",
          "dedup"
        ])

      {:ok, no_entity_index} =
        Options.parse([
          "--tier",
          "t5",
          "--batch-size",
          "10",
          "--distribution",
          "hot",
          "--ablate",
          "entity_index"
        ])

      {:ok, no_group_index} =
        Options.parse([
          "--tier",
          "t5",
          "--batch-size",
          "10",
          "--distribution",
          "hot",
          "--ablate",
          "group_index"
        ])

      count = fn config, cf ->
        config
        |> WriteBatch.build_ops(context.ctx, 1, 0)
        |> Enum.count(fn {:put, op_cf, _key, _value} -> op_cf == cf end)
      end

      assert count.(full, RocksDB.cf_action_dedup()) == 10
      assert count.(no_dedup, RocksDB.cf_action_dedup()) == 0
      assert count.(full, RocksDB.cf_entity_actions()) == 20
      assert count.(no_entity_index, RocksDB.cf_entity_actions()) == 0
      assert count.(no_entity_index, RocksDB.cf_type_entities()) == 0
      assert count.(full, RocksDB.cf_group_actions()) == 10
      assert count.(no_group_index, RocksDB.cf_group_actions()) == 0

      # Every ablation keeps the log record itself.
      for config <- [full, no_dedup, no_entity_index, no_group_index] do
        assert count.(config, RocksDB.cf_actions()) == 10
      end
    end
  end

  describe "build_ops/4" do
    test "a hot batch writes five rows per Action plus two shared type keys", context do
      {:ok, config} =
        Options.parse(["--tier", "t5", "--batch-size", "100", "--distribution", "hot"])

      ops = WriteBatch.build_ops(config, context.ctx, 1, 0)

      # 100 Actions x (cf_actions + dedup + group + 2 entity rows) = 500,
      # plus the two type keys every hot Action shares.
      assert length(ops) == 502
    end

    test "a spread batch writes one type key per Update", context do
      {:ok, config} =
        Options.parse(["--tier", "t5", "--batch-size", "100", "--distribution", "spread"])

      ops = WriteBatch.build_ops(config, context.ctx, 1, 0)

      # 100 Actions x 5 rows plus 100 Actions x 2 uniquely-typed Updates.
      assert length(ops) == 700
    end

    test "cf_actions holds one contiguous GSN range per call, in order", context do
      {:ok, config} = Options.parse(["--tier", "t5", "--batch-size", "10"])
      ops = WriteBatch.build_ops(config, context.ctx, 1, 0)

      gsns = ops |> cf_ops(RocksDB.cf_actions()) |> Enum.map(fn {key, _value} -> key end)

      assert Enum.map(gsns, &RocksDB.decode_gsn_key/1) ==
               Enum.to_list(1_000_000_000..1_000_000_009)
    end

    test "cf_actions stores the GSN-free v1 frame", context do
      {:ok, config} = Options.parse(["--tier", "t5", "--batch-size", "1"])
      ops = WriteBatch.build_ops(config, context.ctx, 1, 0)
      [{_key, value}] = cf_ops(ops, RocksDB.cf_actions())

      # The raw value is the v1 frame: a version byte, the payload's length,
      # the payload ETF, and the scopes ETF. None of them carries the GSN,
      # which lives only in the cf_actions key.
      assert <<1, size::32, payload_etf::binary-size(size), scopes_etf::binary>> = value
      assert :erlang.binary_to_term(scopes_etf) == [[Workbook.group_id()], [Workbook.group_id()]]

      payload = :erlang.binary_to_term(payload_etf)
      refute Map.has_key?(payload, "gsn")
      refute Map.has_key?(payload, "update_scopes")

      stored = ActionFormat.decode(value, 1_000_000_000)

      assert stored["gsn"] == 1_000_000_000
      assert stored["actor_id"] == Workbook.actor_id()
      assert stored["update_scopes"] == [[Workbook.group_id()], [Workbook.group_id()]]
      assert length(stored["updates"]) == 2
      assert Enum.all?(stored["updates"], &is_map_key(&1, "subject_type"))
    end

    test "index rows point at the Action and its GSN", context do
      {:ok, config} = Options.parse(["--tier", "t5", "--batch-size", "2"])
      ops = WriteBatch.build_ops(config, context.ctx, 1, 0)

      [{gsn_key, action_value}, {_second_gsn_key, _}] = cf_ops(ops, RocksDB.cf_actions())
      action_id = ActionFormat.decode(action_value, RocksDB.decode_gsn_key(gsn_key))["id"]

      assert [{^action_id, gsn} | _rest] = cf_ops(ops, RocksDB.cf_action_dedup())
      assert RocksDB.decode_gsn_key(gsn) == 1_000_000_000

      assert [{group_key, ^action_id}] = Enum.take(cf_ops(ops, RocksDB.cf_group_actions()), 1)
      assert RocksDB.decode_group_action_key(group_key) == {Workbook.group_id(), 1_000_000_000}

      first_action_rows =
        ops
        |> cf_ops(RocksDB.cf_entity_actions())
        |> Enum.filter(fn {key, _id} ->
          RocksDB.decode_entity_gsn_key(key) |> elem(1) == 1_000_000_000
        end)

      assert length(first_action_rows) == 2
      assert Enum.all?(first_action_rows, fn {_key, id} -> id == action_id end)
    end

    test "entity index keys cover every Update subject and GSN", context do
      {:ok, config} = Options.parse(["--tier", "t5", "--batch-size", "10"])
      ops = WriteBatch.build_ops(config, context.ctx, 1, 0)

      keys = ops |> cf_ops(RocksDB.cf_entity_actions()) |> Enum.map(&elem(&1, 0))
      decoded = Enum.map(keys, &RocksDB.decode_entity_gsn_key/1)

      assert length(decoded) == 20
      assert decoded |> Enum.map(&elem(&1, 1)) |> Enum.uniq() |> length() == 10
    end

    test "type entity keys are unique and one per distinct entity/type pair", context do
      {:ok, config} =
        Options.parse(["--tier", "t5", "--batch-size", "20", "--distribution", "spread"])

      ops = WriteBatch.build_ops(config, context.ctx, 1, 0)

      keys = ops |> cf_ops(RocksDB.cf_type_entities()) |> Enum.map(&elem(&1, 0))

      assert length(keys) == 40
      assert length(Enum.uniq(keys)) == 40
      assert Enum.count(keys, &String.starts_with?(&1, "todo\x00")) == 20
      assert Enum.count(keys, &String.starts_with?(&1, "entityGroup\x00")) == 20
    end
  end

  defp cf_ops(ops, cf), do: for({:put, ^cf, key, value} <- ops, do: {key, value})
end
