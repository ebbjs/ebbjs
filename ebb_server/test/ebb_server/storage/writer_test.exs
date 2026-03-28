defmodule EbbServer.Storage.WriterTest do
  use ExUnit.Case, async: false

  alias EbbServer.Storage.{RocksDB, SystemCache, Writer}
  import EbbServer.TestHelpers

  defp start_isolated_cache do
    unique_id = System.unique_integer([:positive])
    dirty_set_name = :"ebb_dirty_#{unique_id}"
    gsn_counter_name = :"ebb_gsn_#{unique_id}"
    cache_name = :"ebb_cache_#{unique_id}"

    counter = :atomics.new(1, signed: false)
    :persistent_term.put(gsn_counter_name, counter)

    {:ok, _pid} =
      SystemCache.start_link(
        name: cache_name,
        dirty_set: dirty_set_name,
        gsn_counter: counter,
        gsn_counter_name: gsn_counter_name
      )

    on_exit(fn ->
      if pid = Process.whereis(cache_name), do: GenServer.stop(pid)
      :persistent_term.erase(gsn_counter_name)
    end)

    %{dirty_set: dirty_set_name, gsn_counter: counter}
  end

  defp start_rocks do
    unique_id = System.unique_integer([:positive])
    dir = tmp_dir(%{module: __MODULE__, test: "rocks_#{unique_id}"})
    name = :"rocks_#{unique_id}"
    {:ok, pid} = RocksDB.start_link(data_dir: dir, name: name)

    on_exit(fn ->
      if Process.alive?(pid), do: GenServer.stop(pid)
    end)

    %{name: name, pid: pid, dir: dir}
  end

  defp start_writer(opts) do
    name = :"writer_#{System.unique_integer([:positive])}"
    {:ok, pid} = Writer.start_link(name: name, rocks_name: opts.rocks_name, dirty_set: opts.dirty_set, gsn_counter: opts.gsn_counter)

    on_exit(fn ->
      if Process.alive?(pid), do: GenServer.stop(pid)
    end)

    %{name: name, pid: pid}
  end

  setup do
    %{dirty_set: dirty_set, gsn_counter: gsn_counter} = start_isolated_cache()
    %{name: rocks_name, dir: rocks_dir} = start_rocks()
    %{name: writer_name} = start_writer(%{rocks_name: rocks_name, dirty_set: dirty_set, gsn_counter: gsn_counter})

    %{writer_name: writer_name, rocks_name: rocks_name, rocks_dir: rocks_dir, dirty_set: dirty_set, gsn_counter: gsn_counter}
  end

  describe "single action write" do
    test "returns correct GSN range and writes to cf_actions", %{
      writer_name: writer_name,
      rocks_name: rocks_name
    } do
      action = sample_action()

      assert {:ok, {1, 1}, []} = Writer.write_actions([action], writer_name)

      gsn_key = RocksDB.encode_gsn_key(1)

      assert {:ok, binary} =
               RocksDB.get(RocksDB.cf_actions(rocks_name), gsn_key, name: rocks_name)

      decoded = :erlang.binary_to_term(binary, [:safe])
      assert decoded["gsn"] == 1
    end
  end

  describe "GSN assignment is sequential" do
    test "assigns consecutive GSNs across multiple writes", %{
      writer_name: writer_name
    } do
      action1 = sample_action()
      action2 = sample_action()
      action3 = sample_action()

      assert {:ok, {1, 1}, []} = Writer.write_actions([action1], writer_name)
      assert {:ok, {2, 2}, []} = Writer.write_actions([action2], writer_name)
      assert {:ok, {3, 3}, []} = Writer.write_actions([action3], writer_name)
    end
  end

  describe "all 5 column families are populated" do
    test "writes to all column families for one action with one update", %{
      writer_name: writer_name,
      rocks_name: rocks_name
    } do
      update = sample_update(%{"subject_id" => "todo_test_123", "subject_type" => "todo"})
      action = sample_action(%{"updates" => [update]})

      assert {:ok, {1, 1}, []} = Writer.write_actions([action], writer_name)

      gsn_key = RocksDB.encode_gsn_key(1)
      action_etf = :erlang.term_to_binary(Map.put(action, "gsn", 1))

      assert {:ok, ^action_etf} =
               RocksDB.get(RocksDB.cf_actions(rocks_name), gsn_key, name: rocks_name)

      update_key = RocksDB.encode_update_key(action["id"], update["id"])
      update_etf = :erlang.term_to_binary(update)

      assert {:ok, ^update_etf} =
               RocksDB.get(RocksDB.cf_updates(rocks_name), update_key, name: rocks_name)

      entity_gsn_key = RocksDB.encode_entity_gsn_key("todo_test_123", 1)

      assert {:ok, action_id} =
               RocksDB.get(RocksDB.cf_entity_actions(rocks_name), entity_gsn_key,
                 name: rocks_name
               )

      assert action_id == action["id"]

      type_entity_key = RocksDB.encode_type_entity_key("todo", "todo_test_123")

      assert {:ok, <<>>} =
               RocksDB.get(RocksDB.cf_type_entities(rocks_name), type_entity_key,
                 name: rocks_name
               )

      assert {:ok, ^gsn_key} =
               RocksDB.get(RocksDB.cf_action_dedup(rocks_name), action["id"], name: rocks_name)
    end
  end

  describe "ETF round-trip" do
    test "action survives encode/decode round-trip", %{
      writer_name: writer_name,
      rocks_name: rocks_name
    } do
      update =
        sample_update(%{
          "subject_id" => "todo_roundtrip",
          "data" => %{
            "fields" => %{"title" => %{"type" => "lww", "value" => "Test", "hlc" => 12345}}
          }
        })

      action =
        sample_action(%{
          "id" => "act_roundtrip",
          "updates" => [update]
        })

      Writer.write_actions([action], writer_name)

      gsn_key = RocksDB.encode_gsn_key(1)
      {:ok, binary} = RocksDB.get(RocksDB.cf_actions(rocks_name), gsn_key, name: rocks_name)
      decoded = :erlang.binary_to_term(binary, [:safe])

      assert decoded["id"] == action["id"]
      assert decoded["actor_id"] == action["actor_id"]
      assert decoded["gsn"] == 1
      assert length(decoded["updates"]) == 1
      assert hd(decoded["updates"])["subject_id"] == "todo_roundtrip"
    end
  end

  describe "dirty set is updated" do
    test "marks entity dirty after write", %{
      writer_name: writer_name,
      dirty_set: dirty_set
    } do
      action = sample_action(%{"updates" => [sample_update(%{"subject_id" => "todo_abc"})]})

      Writer.write_actions([action], writer_name)

      assert SystemCache.is_dirty?("todo_abc", dirty_set)
    end
  end

  describe "durability" do
    test "data survives Writer and RocksDB restart", %{
      dirty_set: dirty_set,
      gsn_counter: gsn_counter
    } do
      dir = tmp_dir(%{module: __MODULE__, test: "durability_#{System.unique_integer([:positive])}"})
      action = sample_action()

      rocks_name1 = :"rocks_#{System.unique_integer([:positive])}"
      {:ok, _rocks_pid1} = RocksDB.start_link(data_dir: dir, name: rocks_name1)

      writer_name1 = :"writer_#{System.unique_integer([:positive])}"
      {:ok, _writer_pid1} = Writer.start_link(name: writer_name1, rocks_name: rocks_name1, dirty_set: dirty_set, gsn_counter: gsn_counter)

      Writer.write_actions([action], writer_name1)

      GenServer.stop(writer_name1)
      GenServer.stop(rocks_name1)

      rocks_name2 = :"rocks_#{System.unique_integer([:positive])}"
      {:ok, _rocks_pid2} = RocksDB.start_link(data_dir: dir, name: rocks_name2)

      writer_name2 = :"writer_#{System.unique_integer([:positive])}"
      {:ok, _writer_pid2} = Writer.start_link(name: writer_name2, rocks_name: rocks_name2, dirty_set: dirty_set, gsn_counter: gsn_counter)

      on_exit(fn ->
        if pid = Process.whereis(writer_name2), do: (if Process.alive?(pid), do: GenServer.stop(pid))
        if pid = Process.whereis(rocks_name2), do: (if Process.alive?(pid), do: GenServer.stop(pid))
      end)

      gsn_key = RocksDB.encode_gsn_key(1)

      assert {:ok, _binary} =
               RocksDB.get(RocksDB.cf_actions(rocks_name2), gsn_key, name: rocks_name2)
    end
  end

  describe "validation" do
    test "actions with empty updates are filtered out", %{
      writer_name: writer_name,
      rocks_name: rocks_name
    } do
      action1 = sample_action(%{"id" => "act_valid", "updates" => [sample_update()]})
      action2 = sample_action(%{"id" => "act_empty", "updates" => []})

      assert {:ok, {1, 1}, [%{reason: "no updates"}]} =
               Writer.write_actions([action1, action2], writer_name)

      gsn_key = RocksDB.encode_gsn_key(1)
      assert {:ok, _} = RocksDB.get(RocksDB.cf_actions(rocks_name), gsn_key, name: rocks_name)

      gsn_key2 = RocksDB.encode_gsn_key(2)
      assert :not_found = RocksDB.get(RocksDB.cf_actions(rocks_name), gsn_key2, name: rocks_name)
    end

    test "actions with invalid updates are rejected", %{
      writer_name: writer_name
    } do
      action_with_nil_subject_id =
        sample_action(%{"id" => "act_nil_id", "updates" => [%{"subject_id" => nil}]})

      assert {:ok, {0, 0}, [%{reason: "update id must be a string"}]} =
               Writer.write_actions([action_with_nil_subject_id], writer_name)
    end

    test "all invalid actions returns empty GSN range with rejections", %{
      writer_name: writer_name
    } do
      action_with_nil_subject_id =
        sample_action(%{"id" => "act_nil_id", "updates" => [%{"subject_id" => nil}]})

      assert {:ok, {0, 0}, [%{reason: "update id must be a string"}]} =
               Writer.write_actions([action_with_nil_subject_id], writer_name)
    end

    test "only valid actions are written when mixed with invalid", %{
      writer_name: writer_name,
      rocks_name: rocks_name
    } do
      valid_action = sample_action(%{"id" => "act_valid", "updates" => [sample_update()]})

      invalid_action =
        sample_action(%{"id" => "act_invalid", "updates" => [%{"subject_id" => nil}]})

      assert {:ok, {1, 1}, [%{reason: "update id must be a string"}]} =
               Writer.write_actions([valid_action, invalid_action], writer_name)

      gsn_key = RocksDB.encode_gsn_key(1)
      assert {:ok, _} = RocksDB.get(RocksDB.cf_actions(rocks_name), gsn_key, name: rocks_name)

      gsn_key2 = RocksDB.encode_gsn_key(2)
      assert :not_found = RocksDB.get(RocksDB.cf_actions(rocks_name), gsn_key2, name: rocks_name)
    end
  end
end
