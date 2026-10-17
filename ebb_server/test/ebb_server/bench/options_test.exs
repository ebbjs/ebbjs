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
end
