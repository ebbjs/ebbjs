defmodule EbbServer.Bench.EnvelopeTest do
  @moduledoc """
  Pins the `mix bench.envelope` option surface and the four stored shapes
  the benchmark compares, so a change to the envelope cannot silently change
  what the report measures.
  """

  use ExUnit.Case, async: true

  alias EbbServer.Bench.Envelope.{Options, Shapes}
  alias EbbServer.Storage.{ActionFormat, RocksDB}

  @payload_etf ActionFormat.encode(%{
                 "id" => "act_1",
                 "actor_id" => "a_1",
                 "hlc" => 123,
                 "updates" => [%{"id" => "upd_1", "method" => "put"}]
               })
  @scopes [["g_1"], ["g_1", "g_2"]]
  @input %{payload_etf: @payload_etf, update_scopes: @scopes, gsn: 42}

  describe "options" do
    test "defaults compare all four shapes at 100 and 152 Actions per flush" do
      assert {:ok, config} = Options.parse([])
      assert config.shapes == [:wrapper, :versioned_wrapper, :companion, :frame]
      assert config.flush_sizes == [100, 152]
      assert config.reads == 1000
      assert config.updates_per_action == 2
      assert config.runs == 3
      assert config.port == 4212
    end

    test "parses every option and prints an explicit reproduction command" do
      assert {:ok, config} =
               Options.parse([
                 "--shapes",
                 "frame,wrapper",
                 "--flush-sizes",
                 "100,152",
                 "--reads",
                 "2000",
                 "--updates-per-action",
                 "10",
                 "--runs",
                 "5",
                 "--port",
                 "4300",
                 "--out",
                 "bench/results/x.md"
               ])

      assert config.shapes == [:frame, :wrapper]
      assert config.flush_sizes == [100, 152]

      command = Options.command(config)

      for fragment <- [
            "mix bench.envelope",
            "--shapes frame,wrapper",
            "--flush-sizes 100,152",
            "--reads 2000",
            "--updates-per-action 10",
            "--runs 5",
            "--port 4300",
            "--out bench/results/x.md"
          ] do
        assert command =~ fragment
      end
    end

    test "rejects an unknown shape" do
      assert {:error, message} = Options.parse(["--shapes", "wrapper,envelope"])
      assert message =~ "envelope"
    end

    test "accepts versioned_wrapper on its own" do
      assert {:ok, config} = Options.parse(["--shapes", "versioned_wrapper"])
      assert config.shapes == [:versioned_wrapper]
    end

    test "rejects an empty shape list" do
      assert {:error, message} = Options.parse(["--shapes", ","])
      assert message =~ "--shapes"
    end

    test "rejects non-integer flush sizes" do
      assert {:error, message} = Options.parse(["--flush-sizes", "100,big"])
      assert message =~ "--flush-sizes"
    end

    test "rejects a zero or oversized flush size" do
      assert {:error, _} = Options.parse(["--flush-sizes", "0"])
      assert {:error, _} = Options.parse(["--flush-sizes", "100000"])
    end

    test "rejects too few reads, too many updates, and no runs" do
      assert {:error, message} = Options.parse(["--reads", "2"])
      assert message =~ "--reads"

      assert {:error, message} = Options.parse(["--updates-per-action", "11"])
      assert message =~ "--updates-per-action"

      assert {:error, message} = Options.parse(["--runs", "0"])
      assert message =~ "--runs"
    end

    test "rejects an invalid port, unknown options, and stray arguments" do
      assert {:error, message} = Options.parse(["--port", "70000"])
      assert message =~ "--port"

      assert {:error, message} = Options.parse(["--nonsense", "1"])
      assert message =~ "--nonsense"

      assert {:error, message} = Options.parse(["stray"])
      assert message =~ "unexpected arguments"
    end
  end

  describe "shapes" do
    test "the shape list is exactly the four compared shapes, in report order" do
      assert Shapes.shapes() == [:wrapper, :versioned_wrapper, :companion, :frame]
      assert Shapes.by_name()["versioned_wrapper"] == :versioned_wrapper
    end

    test "wrapper round-trips through decode/2 and decode_payload/2" do
      stored = Shapes.stored(:wrapper, Shapes.cf_actions_value(:wrapper, @input))

      assert %{"id" => "act_1", "gsn" => 42, "update_scopes" => @scopes} =
               Shapes.decode(stored, 42)

      assert %{"id" => "act_1", "gsn" => 42} = payload = Shapes.decode_payload(stored, 42)
      refute Map.has_key?(payload, "update_scopes")
    end

    test "versioned_wrapper is the wrapper tuple plus a version integer" do
      assert Shapes.cf_actions_value(:versioned_wrapper, @input) ==
               :erlang.term_to_binary({1, @payload_etf, @scopes})

      stored =
        Shapes.stored(:versioned_wrapper, Shapes.cf_actions_value(:versioned_wrapper, @input))

      assert %{"id" => "act_1", "gsn" => 42, "update_scopes" => @scopes} =
               Shapes.decode(stored, 42)

      assert %{"id" => "act_1", "gsn" => 42} = payload = Shapes.decode_payload(stored, 42)
      refute Map.has_key?(payload, "update_scopes")

      assert Shapes.extra_ops(:versioned_wrapper, @input) == []
      assert %{value: bytes, extra: 0} = Shapes.stored_bytes(:versioned_wrapper, @input)

      assert bytes ==
               byte_size(Shapes.cf_actions_value(:versioned_wrapper, @input))
    end

    test "companion decodes the bare payload and its second-record scopes" do
      value = Shapes.cf_actions_value(:companion, @input)
      assert value == @payload_etf

      stored = Shapes.stored(:companion, value, @scopes)

      assert %{"id" => "act_1", "gsn" => 42, "update_scopes" => @scopes} =
               Shapes.decode(stored, 42)

      assert %{"id" => "act_1", "gsn" => 42} = payload = Shapes.decode_payload(stored, 42)
      refute Map.has_key?(payload, "update_scopes")
    end

    test "companion's scopes round-trip through its extra put and point read" do
      %{name: rocks_name} = EbbServer.TestHelpers.start_rocks()

      gsn_key = RocksDB.encode_gsn_key(@input.gsn)

      ops =
        [
          {:put, RocksDB.cf_actions(rocks_name), gsn_key,
           Shapes.cf_actions_value(:companion, @input)}
        ] ++ Shapes.extra_ops(:companion, @input)

      :ok = RocksDB.write_batch(ops, name: rocks_name)

      assert Shapes.read_scopes(@input.gsn, rocks_name) == @scopes

      assert %{"gsn" => 42, "update_scopes" => @scopes} =
               Shapes.decode(
                 Shapes.stored(
                   :companion,
                   Shapes.cf_actions_value(:companion, @input),
                   Shapes.read_scopes(@input.gsn, rocks_name)
                 ),
                 42
               )
    end

    test "frame round-trips through decode/2 and decode_payload/2" do
      stored = Shapes.stored(:frame, Shapes.cf_actions_value(:frame, @input))

      assert %{"id" => "act_1", "gsn" => 42, "update_scopes" => @scopes} =
               Shapes.decode(stored, 42)

      assert %{"id" => "act_1", "gsn" => 42} = payload = Shapes.decode_payload(stored, 42)
      refute Map.has_key?(payload, "update_scopes")
    end

    test "the frame shape's value is byte-identical to ActionFormat.frame/2" do
      assert Shapes.cf_actions_value(:frame, @input) ==
               ActionFormat.frame(@payload_etf, @scopes)
    end

    test "only the companion needs an extra durable put, under a non-GSN key" do
      assert Shapes.extra_ops(:wrapper, @input) == []
      assert Shapes.extra_ops(:versioned_wrapper, @input) == []
      assert Shapes.extra_ops(:frame, @input) == []

      assert [{:put, _cf, key, _value}] = Shapes.extra_ops(:companion, @input)
      refute byte_size(key) == 8
      assert key == Shapes.scopes_key(@input.gsn)
      refute key == RocksDB.encode_gsn_key(@input.gsn)
    end
  end
end
