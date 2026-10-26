defmodule EbbServer.Bench.OptionsTest do
  @moduledoc """
  Pins the `--ablate` option surface: parsing, validation, and the
  self-describing report fields.

  The phase set is written out as an independent literal so a change to
  the ablation surface has to be reflected here deliberately.
  """

  use ExUnit.Case, async: true

  alias EbbServer.Bench.Options

  @phases [
    :dedup,
    :group_resolution,
    :build,
    :encode,
    :entity_actions,
    :type_entities,
    :entity_index,
    :group_index,
    :dirty,
    :cache,
    :watermark,
    :fanout
  ]

  describe "--ablate parsing" do
    test "defaults to no ablation" do
      assert {:ok, config} = Options.parse([])
      assert config.ablate == []
    end

    test "parses a comma-separated phase list into atoms" do
      assert {:ok, config} = Options.parse(["--ablate", "dedup,cache"])
      assert config.ablate == [:dedup, :cache]
    end

    test "tolerates whitespace and duplicate names" do
      assert {:ok, config} = Options.parse(["--ablate", " dedup , cache ,dedup "])
      assert config.ablate == [:dedup, :cache]
    end

    test "an empty value means no ablation" do
      assert {:ok, config} = Options.parse(["--ablate", ""])
      assert config.ablate == []
    end

    test "`all` expands to every phase" do
      assert {:ok, config} = Options.parse(["--ablate", "all"])
      assert Enum.sort(config.ablate) == Enum.sort(@phases)
    end

    test "rejects an unknown phase by name" do
      assert {:error, message} = Options.parse(["--ablate", "dedup,bogus"])
      assert message =~ "bogus"
      assert message =~ "--ablate"
    end

    test "canonicalizes the reported order" do
      assert {:ok, config} = Options.parse(["--ablate", "watermark,dirty"])
      assert config.ablate == [:dirty, :watermark]
    end

    test "parses the pre-encode phases in canonical order" do
      assert {:ok, config} = Options.parse(["--ablate", "encode,build"])
      assert config.ablate == [:build, :encode]
    end
  end

  describe "--in-flight" do
    test "defaults to a single call in flight" do
      assert {:ok, config} = Options.parse([])
      assert config.in_flight == [1]
      assert Options.depth(config) == 1
    end

    test "parses a comma-separated depth list, deduped in order" do
      assert {:ok, config} = Options.parse(["--in-flight", " 2 , 1,2,4 "])
      assert config.in_flight == [2, 1, 4]
    end

    test "describe marks a sweep and the command carries the list" do
      assert {:ok, config} = Options.parse(["--in-flight", "1,2,4"])

      assert Map.new(Options.describe(config))["Calls in flight per worker"] == "1, 2, 4 (sweep)"
      assert Options.command(config) =~ "--in-flight 1,2,4"
    end

    test "a single depth is described without the sweep marker" do
      assert {:ok, config} = Options.parse(["--in-flight", "4"])

      assert Map.new(Options.describe(config))["Calls in flight per worker"] == "4"
      assert Options.command(config) =~ "--in-flight 4"
    end

    test "depth/1 raises on a sweep" do
      assert {:ok, config} = Options.parse(["--in-flight", "1,2"])
      assert_raise ArgumentError, fn -> Options.depth(config) end
    end

    test "accepts a sweep on t0, t2, and t3" do
      for tier <- ~w(t0 t2 t3) do
        assert {:ok, config} = Options.parse(["--tier", tier, "--in-flight", "1,2,4"])
        assert config.in_flight == [1, 2, 4]
      end
    end

    test "rejects pipelining on tiers that cannot keep calls outstanding" do
      assert {:error, t1} = Options.parse(["--tier", "t1", "--in-flight", "2"])
      assert t1 =~ "--in-flight"

      assert {:error, t4} = Options.parse(["--tier", "t4", "--rate", "100", "--in-flight", "2"])
      assert t4 =~ "--in-flight"

      assert {:error, t5} = Options.parse(["--tier", "t5", "--in-flight", "2"])
      assert t5 =~ "--in-flight"
    end

    test "a single call in flight stays legal on every tier" do
      assert {:ok, _config} = Options.parse(["--tier", "t1", "--in-flight", "1"])
      assert {:ok, _config} = Options.parse(["--tier", "t4", "--rate", "100", "--in-flight", "1"])
      assert {:ok, _config} = Options.parse(["--tier", "t5", "--in-flight", "1"])
    end

    test "rejects non-positive and non-integer depths" do
      for value <- ~w(0 -1 2,x nine) do
        assert {:error, message} = Options.parse(["--in-flight", value])
        assert message =~ "--in-flight"
      end
    end

    test "rejects an empty list" do
      assert {:error, message} = Options.parse(["--in-flight", ""])
      assert message =~ "--in-flight"
    end
  end

  describe "writer coalescing options" do
    test "defaults match the production Writer settings" do
      assert {:ok, config} = Options.parse([])
      assert config.batch_timeout_ms == 0
      assert config.batch_max_size == 1000
    end

    test "parses both knobs" do
      assert {:ok, config} =
               Options.parse(["--batch-timeout-ms", "5", "--batch-max-size", "128"])

      assert config.batch_timeout_ms == 5
      assert config.batch_max_size == 128
    end

    test "describes the effective coalescing policy" do
      assert {:ok, default} = Options.parse([])

      values = Map.new(Options.describe(default))
      assert values["Writer batch timeout"] =~ "0 ms"
      assert values["Writer batch cap"] == "1000 Actions"

      assert {:ok, tuned} =
               Options.parse(["--batch-timeout-ms", "1", "--batch-max-size", "256"])

      values = Map.new(Options.describe(tuned))
      assert values["Writer batch timeout"] == "1 ms"
      assert values["Writer batch cap"] == "256 Actions"
    end

    test "the reproduction command names both knobs" do
      assert {:ok, config} = Options.parse([])
      command = Options.command(config)

      assert command =~ "--batch-timeout-ms 0"
      assert command =~ "--batch-max-size 1000"
    end

    test "rejects a negative timeout" do
      assert {:error, message} = Options.parse(["--batch-timeout-ms", "-1"])
      assert message =~ "--batch-timeout-ms"
    end

    test "rejects a non-positive cap" do
      for value <- ~w(0 -128) do
        assert {:error, message} = Options.parse(["--batch-max-size", value])
        assert message =~ "--batch-max-size"
      end
    end

    test "rejects non-integer values" do
      assert {:error, message} = Options.parse(["--batch-timeout-ms", "soon"])
      assert message =~ "--batch-timeout-ms"

      assert {:error, message} = Options.parse(["--batch-max-size", "big"])
      assert message =~ "--batch-max-size"
    end
  end

  describe "--rate and tier t4" do
    test "t4 requires a positive --rate" do
      assert {:error, message} = Options.parse(["--tier", "t4"])
      assert message =~ "--rate"
    end

    test "t4 accepts a positive rate at concurrency 1" do
      assert {:ok, config} = Options.parse(["--tier", "t4", "--rate", "1000"])
      assert config.tier == :t4
      assert config.rate == 1000
    end

    test "t4 requires concurrency 1" do
      assert {:error, message} =
               Options.parse(["--tier", "t4", "--rate", "1000", "--concurrency", "2"])

      assert message =~ "concurrency"
    end

    test "rejects --rate on t0, t1, t2, and t3" do
      for tier <- ~w(t0 t1 t2 t3) do
        assert {:error, message} = Options.parse(["--tier", tier, "--rate", "1"])
        assert message =~ "--rate"
      end
    end

    test "rejects a negative --rate" do
      assert {:error, message} = Options.parse(["--tier", "t4", "--rate", "-1"])
      assert message =~ "--rate"
    end

    test "allows --subscribers on t3 and t4 but not t0, t1, or t2" do
      assert {:ok, _config} = Options.parse(["--tier", "t3", "--subscribers", "10"])

      assert {:ok, _config} =
               Options.parse(["--tier", "t4", "--rate", "100", "--subscribers", "10"])

      assert {:error, message} = Options.parse(["--subscribers", "10"])
      assert message =~ "--subscribers"
    end

    test "batch_interval_us paces one batch to the target rate" do
      {:ok, config} = Options.parse(["--tier", "t4", "--rate", "1000", "--batch-size", "100"])
      assert Options.batch_interval_us(config) == 100_000
    end

    test "batch_interval_us scales with the batch size" do
      {:ok, config} = Options.parse(["--tier", "t4", "--rate", "500", "--batch-size", "10"])
      assert Options.batch_interval_us(config) == 20_000
    end

    test "batch_interval_us floors at one microsecond at extreme rates" do
      {:ok, config} = Options.parse(["--tier", "t4", "--rate", "2000000", "--batch-size", "1"])
      assert Options.batch_interval_us(config) == 1
    end

    test "describe and command carry the target rate" do
      {:ok, config} = Options.parse(["--tier", "t4", "--rate", "250"])

      assert Map.new(Options.describe(config))["Target Actions/sec"] == "250"
      assert Options.command(config) =~ "--rate 250"
    end
  end

  describe "--subscriber-lean" do
    test "defaults off" do
      assert {:ok, config} = Options.parse([])
      refute config.subscriber_lean
    end

    test "parses the flag on t3 and t4" do
      assert {:ok, config} =
               Options.parse([
                 "--tier",
                 "t4",
                 "--rate",
                 "100",
                 "--subscribers",
                 "10",
                 "--subscriber-lean"
               ])

      assert config.subscriber_lean
    end

    test "rejects lean mode on tiers without subscribers" do
      assert {:error, message} = Options.parse(["--subscriber-lean"])
      assert message =~ "--subscriber-lean"
    end

    test "the reproduction command carries the lean flag" do
      assert {:ok, config} =
               Options.parse(["--tier", "t3", "--subscribers", "10", "--subscriber-lean"])

      assert Options.command(config) =~ "--subscriber-lean"
    end
  end

  describe "--tier t5" do
    test "parses the canonical concurrent write_batch shape" do
      assert {:ok, config} =
               Options.parse([
                 "--tier",
                 "t5",
                 "--concurrency",
                 "4",
                 "--batch-size",
                 "100",
                 "--updates-per-action",
                 "2",
                 "--durability",
                 "async"
               ])

      assert config.tier == :t5
      assert config.concurrency == 4
      assert config.batch_size == 100
      assert config.durability == :async
    end

    test "describes the tier and the caller count" do
      {:ok, config} = Options.parse(["--tier", "t5", "--concurrency", "2"])

      assert Options.tier_description(:t5) =~ "write_batch"
      assert Options.tier_description(:t5) =~ "no Writer"

      values = Map.new(Options.describe(config))
      assert values["Tier"] =~ "t5"
      assert values["Concurrency"] == "2"
    end

    test "the reproduction command names the caller count and durability" do
      {:ok, config} =
        Options.parse(["--tier", "t5", "--concurrency", "2", "--durability", "async"])

      command = Options.command(config)

      assert command =~ "--tier t5"
      assert command =~ "--concurrency 2"
      assert command =~ "--durability async"
    end

    test "rejects --rate" do
      assert {:error, message} = Options.parse(["--tier", "t5", "--rate", "100"])
      assert message =~ "--rate"
    end

    test "rejects --subscribers and --subscriber-lean" do
      assert {:error, message} = Options.parse(["--tier", "t5", "--subscribers", "10"])
      assert message =~ "--subscribers"

      assert {:error, message} = Options.parse(["--tier", "t5", "--subscriber-lean"])
      assert message =~ "--subscriber-lean"
    end

    test "accepts the op-group ablations" do
      assert {:ok, config} =
               Options.parse(["--tier", "t5", "--ablate", "dedup,entity_index,group_index"])

      assert config.ablate == [:dedup, :entity_index, :group_index]
    end

    test "accepts the entity-index halves separately and keeps the combined alias" do
      assert {:ok, split} =
               Options.parse([
                 "--tier",
                 "t5",
                 "--ablate",
                 "dedup,entity_actions,type_entities,group_index"
               ])

      assert split.ablate == [:dedup, :entity_actions, :type_entities, :group_index]

      assert {:ok, combined} =
               Options.parse(["--tier", "t5", "--ablate", "entity_index"])

      assert combined.ablate == [:entity_index]
    end

    test "rejects an ablation that names a Writer phase" do
      assert {:error, message} = Options.parse(["--tier", "t5", "--ablate", "cache"])
      assert message =~ "is not supported with --tier t5"
    end

    test "rejects multiple writers" do
      assert {:error, message} = Options.parse(["--tier", "t5", "--writers", "2"])
      assert message =~ "--writers"
    end
  end

  describe "t5 raw write_batch tier" do
    test "parses and describes the raw NIF tier" do
      assert {:ok, config} = Options.parse(["--tier", "t5", "--concurrency", "4"])
      assert config.tier == :t5
      assert config.concurrency == 4

      descriptions = Map.new(Options.describe(config))
      assert descriptions["Tier"] =~ "raw RocksDB.write_batch/3"
      assert Options.command(config) =~ "--tier t5 --duration"
    end

    test "bypasses_writer?/1 is true only for t5" do
      for tier <- ~w(t0 t1 t2 t3) do
        assert {:ok, config} = Options.parse(["--tier", tier])
        refute Options.bypasses_writer?(config)
      end

      assert {:ok, t4} = Options.parse(["--tier", "t4", "--rate", "100"])
      refute Options.bypasses_writer?(t4)

      assert {:ok, t5} = Options.parse(["--tier", "t5"])
      assert Options.bypasses_writer?(t5)
    end

    test "rejects Writer-only options" do
      assert {:error, rate} = Options.parse(["--tier", "t5", "--rate", "100"])
      assert rate =~ "--rate"

      assert {:error, subs} = Options.parse(["--tier", "t5", "--subscribers", "1"])
      assert subs =~ "--subscribers"

      assert {:error, lean} = Options.parse(["--tier", "t5", "--subscriber-lean"])
      assert lean =~ "--subscriber-lean"

      assert {:error, ablate} = Options.parse(["--tier", "t5", "--ablate", "cache"])
      assert ablate =~ "--ablate"
    end
  end

  describe "self-describing output" do
    test "describe names the ablated phases" do
      assert {:ok, config} = Options.parse(["--ablate", "cache,watermark"])
      values = Map.new(Options.describe(config))

      assert values["Ablated phases"] =~ "cache"
      assert values["Ablated phases"] =~ "watermark"
    end

    test "describe says none when nothing is ablated" do
      assert {:ok, config} = Options.parse([])
      assert Map.new(Options.describe(config))["Ablated phases"] == "none"
    end

    test "the reproduction command carries the ablation" do
      assert {:ok, config} = Options.parse(["--ablate", "cache,watermark"])
      assert Options.command(config) =~ "--ablate cache,watermark"
    end

    test "the reproduction command omits --ablate when nothing is ablated" do
      assert {:ok, config} = Options.parse([])
      refute Options.command(config) =~ "--ablate"
    end
  end

  describe "guardrails and baseline options" do
    test "guardrails are enforced by default" do
      assert {:ok, config} = Options.parse([])
      assert config.guardrails
      assert config.baseline == nil
      assert Map.new(Options.describe(config))["Guardrails"] == "enforced"
    end

    test "--no-guardrails disables enforcement and is printed" do
      assert {:ok, config} = Options.parse(["--no-guardrails"])
      refute config.guardrails

      values = Map.new(Options.describe(config))
      assert values["Guardrails"] == "disabled (--no-guardrails)"
      assert Options.command(config) =~ "--no-guardrails"
    end

    test "--baseline is carried into the description and command" do
      assert {:ok, config} = Options.parse(["--baseline", "/tmp/prior.md"])
      assert config.baseline == "/tmp/prior.md"

      values = Map.new(Options.describe(config))
      assert values["Baseline"] == "/tmp/prior.md"
      assert Options.command(config) =~ "--baseline /tmp/prior.md"
    end

    test "GSN density stays measurable when only the frontier is ablated" do
      assert {:ok, ablated} = Options.parse(["--ablate", "watermark"])
      assert Options.measures_gsn_density?(ablated)
      refute Options.measures_frontier?(ablated)

      assert {:ok, t5} = Options.parse(["--tier", "t5"])
      refute Options.measures_gsn_density?(t5)
    end

    test "workload/1 is the stable comparison surface" do
      assert {:ok, left} = Options.parse(["--seed", "1", "--out", "/tmp/a.md"])
      assert {:ok, right} = Options.parse(["--seed", "9", "--out", "/tmp/b.md"])

      assert Options.workload(left) == Options.workload(right)
      refute Map.has_key?(Options.workload(left), "seed")
      refute Map.has_key?(Options.workload(left), "out")
      assert Options.workload(left)["tier"] == "t0"
    end
  end
end
