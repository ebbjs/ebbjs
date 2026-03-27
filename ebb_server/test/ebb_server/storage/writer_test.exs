defmodule EbbServer.Storage.WriterTest do
  use ExUnit.Case, async: false

  alias EbbServer.Storage.{RocksDB, SystemCache, Writer}
  import EbbServer.TestHelpers

  setup do
    {:ok, system_cache_pid} = SystemCache.start_link()

    dir = tmp_dir(%{module: __MODULE__, test: "setup"})
    rocks_name = :"rocks_#{System.unique_integer([:positive])}"
    {:ok, rocks_pid} = RocksDB.start_link(data_dir: dir, name: rocks_name)

    writer_name = :"writer_#{System.unique_integer([:positive])}"
    {:ok, writer_pid} = Writer.start_link(name: writer_name, rocks_name: rocks_name)

    on_exit(fn ->
      if Process.alive?(writer_pid), do: GenServer.stop(writer_pid)
      if Process.alive?(rocks_pid), do: GenServer.stop(rocks_pid)
      if Process.alive?(system_cache_pid), do: GenServer.stop(system_cache_pid)
    end)

    %{writer_name: writer_name, rocks_name: rocks_name, rocks_dir: dir}
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
      writer_name: writer_name
    } do
      action = sample_action(%{"updates" => [sample_update(%{"subject_id" => "todo_abc"})]})

      Writer.write_actions([action], writer_name)

      assert SystemCache.is_dirty?("todo_abc")
    end
  end

  describe "durability" do
    test "data survives Writer and RocksDB restart", %{
      writer_name: writer_name,
      rocks_name: rocks_name,
      rocks_dir: dir
    } do
      action = sample_action()

      Writer.write_actions([action], writer_name)

      GenServer.stop(writer_name)
      GenServer.stop(rocks_name)

      new_rocks_name = :"rocks_#{System.unique_integer([:positive])}"
      {:ok, new_rocks_pid} = RocksDB.start_link(data_dir: dir, name: new_rocks_name)

      new_writer_name = :"writer_#{System.unique_integer([:positive])}"
      {:ok, new_writer_pid} = Writer.start_link(name: new_writer_name, rocks_name: new_rocks_name)

      on_exit(fn ->
        if Process.alive?(new_writer_pid), do: GenServer.stop(new_writer_pid)
        if Process.alive?(new_rocks_pid), do: GenServer.stop(new_rocks_pid)
      end)

      gsn_key = RocksDB.encode_gsn_key(1)

      assert {:ok, _binary} =
               RocksDB.get(RocksDB.cf_actions(new_rocks_name), gsn_key, name: new_rocks_name)
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
