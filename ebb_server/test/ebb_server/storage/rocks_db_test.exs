defmodule EbbServer.Storage.RocksDBTest do
  use ExUnit.Case, async: true

  alias EbbServer.Storage.RocksDB
  import EbbServer.TestHelpers

  describe "open/close lifecycle" do
    test "starts successfully and accessor functions return references", context do
      %{name: name} = start_rocks(context)

      refute is_nil(RocksDB.db_ref(name))
      refute is_nil(RocksDB.cf_actions(name))
      refute is_nil(RocksDB.cf_updates(name))
      refute is_nil(RocksDB.cf_entity_actions(name))
      refute is_nil(RocksDB.cf_type_entities(name))
      refute is_nil(RocksDB.cf_action_dedup(name))
    end

    test "persistent_term keys are erased after stop", context do
      %{name: name, pid: pid} = start_rocks(context)

      GenServer.stop(pid)

      assert_raise ArgumentError, fn -> RocksDB.db_ref(name) end
      assert_raise ArgumentError, fn -> RocksDB.cf_actions(name) end
      assert_raise ArgumentError, fn -> RocksDB.cf_updates(name) end
      assert_raise ArgumentError, fn -> RocksDB.cf_entity_actions(name) end
      assert_raise ArgumentError, fn -> RocksDB.cf_type_entities(name) end
      assert_raise ArgumentError, fn -> RocksDB.cf_action_dedup(name) end
    end
  end

  describe "write and read round-trip" do
    test "write_batch then get returns the value", context do
      %{name: name} = start_rocks(context)

      key = RocksDB.encode_gsn_key(1)
      value = :erlang.term_to_binary(%{"hello" => "world"})

      assert :ok = RocksDB.write_batch([{:put, RocksDB.cf_actions(name), key, value}], name: name)
      assert {:ok, ^value} = RocksDB.get(RocksDB.cf_actions(name), key, name: name)
    end

    test "get returns :not_found for missing key", context do
      %{name: name} = start_rocks(context)

      assert :not_found = RocksDB.get(RocksDB.cf_actions(name), "nonexistent", name: name)
    end
  end

  describe "prefix iterator" do
    test "iterates only matching prefix entries in GSN order", context do
      %{name: name} = start_rocks(context)
      cf = RocksDB.cf_entity_actions(name)

      key1 = RocksDB.encode_entity_gsn_key("todo_abc", 1)
      key2 = RocksDB.encode_entity_gsn_key("todo_abc", 2)
      key3 = RocksDB.encode_entity_gsn_key("todo_xyz", 1)

      :ok =
        RocksDB.write_batch(
          [
            {:put, cf, key1, "v1"},
            {:put, cf, key2, "v2"},
            {:put, cf, key3, "v3"}
          ],
          name: name
        )

      results =
        RocksDB.prefix_iterator(cf, "todo_abc", name: name)
        |> Enum.to_list()

      assert length(results) == 2

      [{rk1, rv1}, {rk2, rv2}] = results
      assert rv1 == "v1"
      assert rv2 == "v2"

      # Verify GSN order
      {_, gsn1} = RocksDB.decode_entity_gsn_key(rk1)
      {_, gsn2} = RocksDB.decode_entity_gsn_key(rk2)
      assert gsn1 < gsn2
    end
  end

  describe "range iterator" do
    test "returns correct key-value pairs within range", context do
      %{name: name} = start_rocks(context)
      cf = RocksDB.cf_actions(name)

      for gsn <- 10..15 do
        key = RocksDB.encode_gsn_key(gsn)
        value = :erlang.term_to_binary(%{"gsn" => gsn})
        :ok = RocksDB.write_batch([{:put, cf, key, value}], name: name)
      end

      from_key = RocksDB.encode_gsn_key(12)
      to_key = RocksDB.encode_gsn_key(16)

      results =
        RocksDB.range_iterator(cf, from_key, to_key, name: name)
        |> Enum.to_list()

      assert length(results) == 4

      gsns =
        for {key, _value} <- results do
          RocksDB.decode_gsn_key(key)
        end

      assert gsns == [12, 13, 14, 15]
    end

    test "returns empty when from_key >= to_key", context do
      %{name: name} = start_rocks(context)
      cf = RocksDB.cf_actions(name)

      key = RocksDB.encode_gsn_key(5)
      :ok = RocksDB.write_batch([{:put, cf, key, "value"}], name: name)

      from_key = RocksDB.encode_gsn_key(10)
      to_key = RocksDB.encode_gsn_key(5)

      results = RocksDB.range_iterator(cf, from_key, to_key, name: name) |> Enum.to_list()
      assert results == []
    end

    test "returns nothing when no keys exist in range", context do
      %{name: name} = start_rocks(context)
      cf = RocksDB.cf_actions(name)

      key = RocksDB.encode_gsn_key(50)
      :ok = RocksDB.write_batch([{:put, cf, key, "value"}], name: name)

      from_key = RocksDB.encode_gsn_key(10)
      to_key = RocksDB.encode_gsn_key(20)

      results = RocksDB.range_iterator(cf, from_key, to_key, name: name) |> Enum.to_list()
      assert results == []
    end

    test "returns nothing when keys exist but outside range", context do
      %{name: name} = start_rocks(context)
      cf = RocksDB.cf_actions(name)

      for gsn <- [5, 10, 15, 20, 25] do
        key = RocksDB.encode_gsn_key(gsn)
        :ok = RocksDB.write_batch([{:put, cf, key, "v#{gsn}"}], name: name)
      end

      from_key = RocksDB.encode_gsn_key(12)
      to_key = RocksDB.encode_gsn_key(18)

      results = RocksDB.range_iterator(cf, from_key, to_key, name: name) |> Enum.to_list()
      assert length(results) == 1

      [{key, value}] = results
      assert RocksDB.decode_gsn_key(key) == 15
      assert value == "v15"
    end

    test "closes cleanly when partially consumed", context do
      %{name: name} = start_rocks(context)
      cf = RocksDB.cf_actions(name)

      for gsn <- 1..10 do
        key = RocksDB.encode_gsn_key(gsn)
        :ok = RocksDB.write_batch([{:put, cf, key, "value#{gsn}"}], name: name)
      end

      from_key = RocksDB.encode_gsn_key(1)
      to_key = RocksDB.encode_gsn_key(11)

      stream = RocksDB.range_iterator(cf, from_key, to_key, name: name)
      results = stream |> Stream.take(3) |> Enum.to_list()

      assert length(results) == 3
    end

    test "works with GSN-encoded keys (8-byte big-endian)", context do
      %{name: name} = start_rocks(context)
      cf = RocksDB.cf_actions(name)

      high_gsn = 1_000_000_000
      key = RocksDB.encode_gsn_key(high_gsn)
      value = :erlang.term_to_binary(%{"high" => high_gsn})
      :ok = RocksDB.write_batch([{:put, cf, key, value}], name: name)

      from_key = RocksDB.encode_gsn_key(high_gsn)
      to_key = RocksDB.encode_gsn_key(high_gsn + 1)

      [{ret_key, ret_value}] =
        RocksDB.range_iterator(cf, from_key, to_key, name: name) |> Enum.to_list()

      assert ret_key == key
      assert ret_value == value
    end
  end

  describe "durability across restarts" do
    test "data survives process restart with same data_dir", context do
      dir = tmp_dir(context)
      name1 = :"rocks_durable_#{System.unique_integer([:positive])}"

      {:ok, pid1} = RocksDB.start_link(data_dir: dir, name: name1)

      key = RocksDB.encode_gsn_key(42)
      value = "durable_value"

      :ok =
        RocksDB.write_batch(
          [{:put, RocksDB.cf_actions(name1), key, value}],
          name: name1
        )

      GenServer.stop(pid1)

      # Restart with same dir, different name
      name2 = :"rocks_durable_#{System.unique_integer([:positive])}"
      {:ok, pid2} = RocksDB.start_link(data_dir: dir, name: name2)

      on_exit(fn ->
        if Process.alive?(pid2), do: GenServer.stop(pid2)
      end)

      assert {:ok, ^value} = RocksDB.get(RocksDB.cf_actions(name2), key, name: name2)
    end
  end
end
