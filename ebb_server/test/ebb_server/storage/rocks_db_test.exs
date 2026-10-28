defmodule EbbServer.Storage.RocksDBTest do
  use ExUnit.Case, async: true

  alias EbbServer.Storage.RocksDB
  import EbbServer.TestHelpers

  describe "open/close lifecycle" do
    test "starts successfully and accessor functions return references", context do
      %{name: name} = start_rocks(context)

      refute is_nil(RocksDB.db_ref(name))
      refute is_nil(RocksDB.cf_actions(name))
      refute is_nil(RocksDB.cf_entity_actions(name))
      refute is_nil(RocksDB.cf_type_entities(name))
      refute is_nil(RocksDB.cf_action_dedup(name))
      refute is_nil(RocksDB.cf_default(name))
    end

    test "persistent_term keys are erased after stop", context do
      %{name: name, pid: pid} = start_rocks(context)

      GenServer.stop(pid)

      assert_raise ArgumentError, fn -> RocksDB.db_ref(name) end
      assert_raise ArgumentError, fn -> RocksDB.cf_actions(name) end
      assert_raise ArgumentError, fn -> RocksDB.cf_entity_actions(name) end
      assert_raise ArgumentError, fn -> RocksDB.cf_type_entities(name) end
      assert_raise ArgumentError, fn -> RocksDB.cf_action_dedup(name) end
      assert_raise ArgumentError, fn -> RocksDB.cf_group_actions(name) end
      assert_raise ArgumentError, fn -> RocksDB.cf_default(name) end
    end

    test "start_rocks + safe_stop releases the lock and the rocksdb directory can be removed",
         context do
      %{pid: pid, dir: dir} = start_rocks(context)

      rocks_dir = Path.join(dir, "rocksdb")
      assert File.dir?(rocks_dir), "expected RocksDB to create #{inspect(rocks_dir)}"

      # Stop the GenServer the same way `start_rocks/1`'s on_exit does. If
      # `safe_stop/1` releases the RocksDB lock, the next `File.rm_rf/1`
      # will succeed. Otherwise, we would observe a leftover `LOCK` file
      # — the symptom called out in issue #56.
      :ok = safe_stop(pid)

      # `:rocksdb.close/1` runs synchronously inside `terminate/2`, but
      # RocksDB may briefly keep the lock file descriptor open in the
      # kernel. Give the BEAM a moment to fully tear down.
      Process.sleep(50)

      assert {:ok, _removed} = File.rm_rf(rocks_dir),
             "could not remove #{inspect(rocks_dir)} after stop — the RocksDB " <>
               "lock was probably not released. See issue #56."

      refute File.exists?(rocks_dir)
      refute File.exists?(Path.join(rocks_dir, "LOCK"))
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

      key1 = RocksDB.encode_entity_flush_key("todo_abc", 1)
      key2 = RocksDB.encode_entity_flush_key("todo_abc", 2)
      key3 = RocksDB.encode_entity_flush_key("todo_xyz", 1)

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
      {_, gsn1} = RocksDB.decode_entity_flush_key(rk1)
      {_, gsn2} = RocksDB.decode_entity_flush_key(rk2)
      assert gsn1 < gsn2
    end
  end

  describe "entity gsn iterator" do
    test "seeks past the applied GSNs and stays inside the entity", context do
      %{name: name} = start_rocks(context)
      cf = RocksDB.cf_entity_actions(name)

      # Entity ids are the same length here, which is the invariant the
      # prefix bound relies on: no id is a prefix of another.
      ids = %{entity: "todo_aaaaaaaa", other: "todo_bbbbbbbb"}
      gsns = [1, 2, 3, 4]

      ops =
        for {entity_id, gsn} <- Enum.map(gsns, &{ids.entity, &1}) ++ [{ids.other, 3}] do
          {:put, cf, RocksDB.encode_entity_flush_key(entity_id, gsn), "#{entity_id}@#{gsn}"}
        end

      :ok = RocksDB.write_batch(ops, name: name)

      assert [2, 3, 4] = gsns_from(cf, ids.entity, 2, name)
      # From 0 is the whole history, which a cold materialize needs.
      assert [1, 2, 3, 4] = gsns_from(cf, ids.entity, 0, name)
      # Nothing to read once the history is applied.
      assert [] = gsns_from(cf, ids.entity, 5, name)
    end

    test "returns a row whose max GSN is at or after the seek, even when it straddles it",
         context do
      %{name: name} = start_rocks(context)
      cf = RocksDB.cf_entity_actions(name)
      entity_id = "todo_coalesced"

      :ok =
        RocksDB.write_batch(
          [
            {:put, cf, RocksDB.encode_entity_flush_key(entity_id, 5),
             RocksDB.encode_gsn_list([1, 5])},
            {:put, cf, RocksDB.encode_entity_flush_key(entity_id, 10),
             RocksDB.encode_gsn_list([6, 10])}
          ],
          name: name
        )

      rows = fn from_gsn ->
        cf
        |> RocksDB.entity_gsn_iterator(entity_id, from_gsn, name: name)
        |> Enum.map(fn {key, value} ->
          {_entity_id, max_gsn} = RocksDB.decode_entity_flush_key(key)
          {max_gsn, RocksDB.decode_gsn_list(value)}
        end)
      end

      # The seek lands inside the first row's list; its max still keeps it
      # visible, so the reader can filter the applied GSN itself.
      assert rows.(2) == [{5, [1, 5]}, {10, [6, 10]}]
      assert rows.(6) == [{10, [6, 10]}]
      assert rows.(11) == []
    end
  end

  defp gsns_from(cf, entity_id, from_gsn, name) do
    cf
    |> RocksDB.entity_gsn_iterator(entity_id, from_gsn, name: name)
    |> Enum.map(fn {key, _value} -> key |> RocksDB.decode_entity_flush_key() |> elem(1) end)
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

  describe "GSN list values" do
    test "round-trips a sorted GSN list as raw big-endian integers" do
      gsns = [1, 2, 255, 65_536, 1_000_000_000]

      encoded = RocksDB.encode_gsn_list(gsns)

      assert byte_size(encoded) == length(gsns) * 8
      assert encoded == Enum.map_join(gsns, fn gsn -> <<gsn::unsigned-big-integer-size(64)>> end)
      assert RocksDB.decode_gsn_list(encoded) == gsns
    end

    test "normalizes the list to ascending unique GSNs" do
      assert RocksDB.encode_gsn_list([5, 1, 5, 2]) == RocksDB.encode_gsn_list([1, 2, 5])
    end

    test "builds a row keyed at the list's highest GSN" do
      {key, value} = RocksDB.encode_entity_gsn_row("todo_row", [7, 3, 7, 5])

      assert RocksDB.decode_entity_flush_key(key) == {"todo_row", 7}
      assert RocksDB.decode_gsn_list(value) == [3, 5, 7]
    end

    test "raises on an empty GSN list" do
      assert_raise ArgumentError, ~r/cannot be empty/, fn -> RocksDB.encode_gsn_list([]) end
      assert_raise ArgumentError, ~r/cannot be empty/, fn -> RocksDB.decode_gsn_list(<<>>) end
    end

    test "raises on a value whose length is not a multiple of eight" do
      assert_raise ArgumentError, ~r/multiple of 8/, fn ->
        RocksDB.decode_gsn_list(<<1, 2, 3>>)
      end
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

      on_exit(fn -> safe_stop(pid2) end)

      assert {:ok, ^value} = RocksDB.get(RocksDB.cf_actions(name2), key, name: name2)
    end
  end

  describe "restart after the owner dies" do
    @describetag :capture_log

    test "reopens the same data_dir after the owner is killed without terminate/2", context do
      Process.flag(:trap_exit, true)
      %{name: name, pid: pid, dir: dir} = start_rocks(context)

      ref = Process.monitor(pid)
      Process.exit(pid, :kill)
      assert_receive {:DOWN, ^ref, :process, ^pid, :killed}
      assert_receive {:EXIT, ^pid, :killed}

      # The killed process never reached `terminate/2`, so its handles are
      # still published — and that `db_ref` is what holds the RocksDB LOCK
      # file. The replacement has to release it before it can open.
      assert :persistent_term.get({:ebb_rocksdb_db, name}, :absent) != :absent

      assert {:ok, replacement} =
               RocksDB.start_link(data_dir: dir, name: name, open_retry_delays_ms: [50, 100, 200])

      on_exit(fn -> safe_stop(replacement) end)

      key = RocksDB.encode_gsn_key(7)

      assert :ok =
               RocksDB.write_batch([{:put, RocksDB.cf_actions(name), key, "after"}], name: name)

      assert {:ok, "after"} = RocksDB.get(RocksDB.cf_actions(name), key, name: name)
    end

    test "a live owner keeps its handles and the second open fails", context do
      Process.flag(:trap_exit, true)
      %{name: name, dir: dir} = start_rocks(context)

      # A second instance on the same `data_dir` (a different name, so the
      # registration does not reject it first) must fail on the lock.
      other_name = :"rocks_second_#{System.unique_integer([:positive])}"

      assert {:error, {:rocksdb_open_failed, {:db_open, message}}} =
               RocksDB.start_link(data_dir: dir, name: other_name, open_retry_delays_ms: [])

      assert to_string(message) =~ "lock hold by current process"

      # Cleaning up after a dead owner must not detach a live one.
      key = RocksDB.encode_gsn_key(1)

      assert :ok =
               RocksDB.write_batch([{:put, RocksDB.cf_actions(name), key, "live"}], name: name)

      assert {:ok, "live"} = RocksDB.get(RocksDB.cf_actions(name), key, name: name)
    end
  end

  describe "start failure" do
    @describetag :capture_log

    test "an unwritable parent directory stops the start instead of raising", context do
      Process.flag(:trap_exit, true)
      parent = tmp_dir(context)
      File.chmod!(parent, 0o500)
      on_exit(fn -> File.chmod(parent, 0o700) end)

      name = :"rocks_unwritable_#{System.unique_integer([:positive])}"

      assert {:error, {:data_dirCreation_failed, _reason}} =
               RocksDB.start_link(data_dir: Path.join(parent, "nested"), name: name)
    end
  end

  describe "terminate/2" do
    test "releases the published handles when the state carries no db_ref" do
      name = :"rocks_terminate_#{System.unique_integer([:positive])}"
      :persistent_term.put({:ebb_rocksdb_db, name}, make_ref())

      assert RocksDB.terminate(:shutdown, %{name: name}) == :ok
      assert :persistent_term.get({:ebb_rocksdb_db, name}, :absent) == :absent
    end

    test "survives closing a handle the NIF rejects" do
      name = :"rocks_terminate_#{System.unique_integer([:positive])}"

      assert RocksDB.terminate(:shutdown, %{name: name, db_ref: make_ref()}) == :ok
    end

    test "releases handles for a state it does not recognise" do
      assert RocksDB.terminate(:shutdown, :unexpected_state) == :ok
    end
  end
end
