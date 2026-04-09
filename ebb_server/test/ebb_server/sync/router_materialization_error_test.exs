defmodule EbbServer.Sync.Router.MaterializationErrorTest do
  use ExUnit.Case, async: false

  alias EbbServer.Storage.{EntityStore, RocksDB}

  import EbbServer.TestHelpers

  setup do
    %{dirty_set: dirty_set} = start_isolated_cache()
    %{name: rocks_name, dir: rocks_dir} = start_rocks()
    %{name: sqlite_name} = start_sqlite(rocks_dir)

    %{rocks_name: rocks_name, sqlite_name: sqlite_name, dirty_set: dirty_set}
  end

  describe "materialization error handling" do
    test "EntityStore.get returns {:error, :materialization_failed} when action is missing",
         %{
           rocks_name: rocks_name,
           sqlite_name: sqlite_name,
           dirty_set: dirty_set
         } do
      entity_id = "todo_corrupted_#{:rand.uniform(10_000)}"
      gsn = 1

      entity_gsn_key = RocksDB.encode_entity_gsn_key(entity_id, gsn)

      :ok =
        RocksDB.write_batch(
          [{:put, RocksDB.cf_entity_actions(rocks_name), entity_gsn_key, "fake_action_id"}],
          name: rocks_name
        )

      :ets.insert(dirty_set, {entity_id, true})

      assert {:error, :materialization_failed} =
               EntityStore.get(entity_id, "a_test",
                 rocks_name: rocks_name,
                 sqlite_name: sqlite_name,
                 dirty_set: dirty_set
               )
    end

    test "EntityStore.get returns {:error, :materialization_failed} when action data is corrupted",
         %{
           rocks_name: rocks_name,
           sqlite_name: sqlite_name,
           dirty_set: dirty_set
         } do
      entity_id = "todo_corrupted_#{:rand.uniform(10_000)}"
      gsn = 1

      action_etf = :erlang.term_to_binary(%{"invalid" => "action", "updates" => nil})
      action_key = RocksDB.encode_gsn_key(gsn)

      :ok =
        RocksDB.write_batch([{:put, RocksDB.cf_actions(rocks_name), action_key, action_etf}],
          name: rocks_name
        )

      entity_gsn_key = RocksDB.encode_entity_gsn_key(entity_id, gsn)

      :ok =
        RocksDB.write_batch(
          [{:put, RocksDB.cf_entity_actions(rocks_name), entity_gsn_key, "fake_action_id"}],
          name: rocks_name
        )

      :ets.insert(dirty_set, {entity_id, true})

      assert {:error, :materialization_failed} =
               EntityStore.get(entity_id, "a_test",
                 rocks_name: rocks_name,
                 sqlite_name: sqlite_name,
                 dirty_set: dirty_set
               )
    end

    test "EntityStore.get raises CaseClauseError when materialization returns unexpected error",
         %{
           rocks_name: rocks_name,
           sqlite_name: sqlite_name,
           dirty_set: dirty_set
         } do
      entity_id = "todo_corrupted_#{:rand.uniform(10_000)}"
      gsn = 1

      entity_gsn_key = RocksDB.encode_entity_gsn_key(entity_id, gsn)

      :ok =
        RocksDB.write_batch(
          [{:put, RocksDB.cf_entity_actions(rocks_name), entity_gsn_key, "fake_action_id"}],
          name: rocks_name
        )

      :ets.insert(dirty_set, {entity_id, true})

      assert_raise CaseClauseError, fn ->
        case EntityStore.get(entity_id, "a_test",
               rocks_name: rocks_name,
               sqlite_name: sqlite_name,
               dirty_set: dirty_set
             ) do
          {:ok, entity} -> entity
          :not_found -> nil
        end
      end
    end
  end
end
