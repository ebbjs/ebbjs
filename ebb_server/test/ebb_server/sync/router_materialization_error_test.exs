defmodule EbbServer.Sync.Router.MaterializationErrorTest do
  use ExUnit.Case, async: false

  alias EbbServer.Storage.{EntityStore, RocksDB, SQLite, SystemCache}
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
        gsn_counter_name: gsn_counter_name,
        initial_gsn: 0
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

  defp start_sqlite(dir) do
    name = :"sqlite_#{System.unique_integer([:positive])}"
    {:ok, pid} = SQLite.start_link(data_dir: dir, name: name)

    on_exit(fn ->
      if Process.alive?(pid), do: GenServer.stop(pid)
    end)

    %{name: name, pid: pid}
  end

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
