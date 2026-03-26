defmodule EbbServer.Storage.RocksDBTest do
  use ExUnit.Case, async: true

  alias EbbServer.Storage.RocksDB
  import EbbServer.TestHelpers

  defp start_rocks(context) do
    dir = tmp_dir(context)
    name = :"rocks_#{System.unique_integer([:positive])}"
    {:ok, pid} = RocksDB.start_link(data_dir: dir, name: name)

    on_exit(fn ->
      if Process.alive?(pid), do: GenServer.stop(pid)
    end)

    %{name: name, dir: dir, pid: pid}
  end

  describe "key encoding round-trips" do
    test "encode_gsn_key/decode_gsn_key round-trip" do
      assert RocksDB.decode_gsn_key(RocksDB.encode_gsn_key(0)) == 0
      assert RocksDB.decode_gsn_key(RocksDB.encode_gsn_key(42)) == 42

      assert RocksDB.decode_gsn_key(RocksDB.encode_gsn_key(0xFFFFFFFFFFFFFFFF)) ==
               0xFFFFFFFFFFFFFFFF
    end

    test "encode_entity_gsn_key/decode_entity_gsn_key round-trip" do
      assert RocksDB.decode_entity_gsn_key(RocksDB.encode_entity_gsn_key("todo_abc", 100)) ==
               {"todo_abc", 100}

      assert RocksDB.decode_entity_gsn_key(RocksDB.encode_entity_gsn_key("", 0)) == {"", 0}
    end

    test "GSN keys sort lexicographically in GSN order" do
      keys = Enum.map([1, 2, 256, 65_536], &RocksDB.encode_gsn_key/1)

      assert keys == Enum.sort(keys)
    end
  end

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
