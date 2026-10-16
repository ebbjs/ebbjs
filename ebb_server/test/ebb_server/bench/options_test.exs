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
