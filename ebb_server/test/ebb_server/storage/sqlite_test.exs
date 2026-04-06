defmodule EbbServer.Storage.SQLiteTest do
  use ExUnit.Case, async: true

  alias EbbServer.Storage.SQLite
  alias Exqlite.Sqlite3
  import EbbServer.TestHelpers

  defp start_sqlite(context) do
    dir = tmp_dir(context)
    name = :"sqlite_#{System.unique_integer([:positive])}"
    {:ok, pid} = SQLite.start_link(data_dir: dir, name: name)

    on_exit(fn ->
      safe_stop(pid)
    end)

    %{name: name, dir: dir, pid: pid}
  end

  defp open_readonly(dir) do
    path = Path.join(dir, "ebb.db")
    {:ok, db} = Sqlite3.open(path, mode: :readonly)

    on_exit(fn ->
      Sqlite3.close(db)
    end)

    db
  end

  describe "DDL" do
    test "runs without error and creates the entities table", context do
      %{dir: dir} = start_sqlite(context)

      db = open_readonly(dir)

      {:ok, stmt} =
        Sqlite3.prepare(
          db,
          "SELECT name FROM sqlite_master WHERE type='table' AND name='entities'"
        )

      {:row, ["entities"]} = Sqlite3.step(db, stmt)
      :ok = Sqlite3.release(db, stmt)
    end
  end

  describe "upsert and get round-trip" do
    test "upserts an entity and reads it back", context do
      %{name: name} = start_sqlite(context)

      entity = %{
        id: "todo_abc",
        type: "todo",
        data: ~s({"fields":{}}),
        created_hlc: 1000,
        updated_hlc: 1000,
        deleted_hlc: nil,
        deleted_by: nil,
        last_gsn: 1
      }

      :ok = SQLite.upsert_entity(entity, name)

      assert {:ok, result} = SQLite.get_entity("todo_abc", name)
      assert result.id == "todo_abc"
      assert result.type == "todo"
      assert result.data == ~s({"fields":{}})
      assert result.created_hlc == 1000
      assert result.updated_hlc == 1000
      assert result.deleted_hlc == nil
      assert result.deleted_by == nil
      assert result.last_gsn == 1
    end

    test "returns :not_found for nonexistent entity", context do
      %{name: name} = start_sqlite(context)

      assert :not_found = SQLite.get_entity("nonexistent", name)
    end
  end

  describe "get_entity_last_gsn" do
    test "returns the last_gsn for an existing entity", context do
      %{name: name} = start_sqlite(context)

      entity = %{
        id: "todo_abc",
        type: "todo",
        data: ~s({"fields":{}}),
        created_hlc: 1000,
        updated_hlc: 1000,
        deleted_hlc: nil,
        deleted_by: nil,
        last_gsn: 5
      }

      :ok = SQLite.upsert_entity(entity, name)

      assert {:ok, 5} = SQLite.get_entity_last_gsn("todo_abc", name)
    end

    test "returns :not_found for nonexistent entity", context do
      %{name: name} = start_sqlite(context)

      assert :not_found = SQLite.get_entity_last_gsn("nonexistent", name)
    end
  end

  describe "upsert replaces existing" do
    test "second upsert with same ID overwrites the first", context do
      %{name: name} = start_sqlite(context)

      entity_v1 = %{
        id: "todo_abc",
        type: "todo",
        data: ~s({"fields":{}}),
        created_hlc: 1000,
        updated_hlc: 1000,
        deleted_hlc: nil,
        deleted_by: nil,
        last_gsn: 1
      }

      entity_v2 = %{entity_v1 | updated_hlc: 2000, last_gsn: 2}

      :ok = SQLite.upsert_entity(entity_v1, name)
      :ok = SQLite.upsert_entity(entity_v2, name)

      assert {:ok, result} = SQLite.get_entity("todo_abc", name)
      assert result.last_gsn == 2
      assert result.updated_hlc == 2000
    end
  end

  describe "generated columns" do
    test "source_id and target_id are populated from JSON data", context do
      %{name: name, dir: dir} = start_sqlite(context)

      entity = %{
        id: "rel_abc",
        type: "relation",
        data: ~s({"source_id": "src_1", "target_id": "tgt_1"}),
        created_hlc: 1000,
        updated_hlc: 1000,
        deleted_hlc: nil,
        deleted_by: nil,
        last_gsn: 1
      }

      :ok = SQLite.upsert_entity(entity, name)

      # Open a separate read-only connection to query generated columns
      db = open_readonly(dir)
      {:ok, stmt} = Sqlite3.prepare(db, "SELECT source_id, target_id FROM entities WHERE id = ?")
      :ok = Sqlite3.bind(stmt, ["rel_abc"])
      {:row, [source_id, target_id]} = Sqlite3.step(db, stmt)
      :ok = Sqlite3.release(db, stmt)

      assert source_id == "src_1"
      assert target_id == "tgt_1"
    end
  end
end
