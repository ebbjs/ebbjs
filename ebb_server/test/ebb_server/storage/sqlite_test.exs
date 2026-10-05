defmodule EbbServer.Storage.SQLiteTest do
  use ExUnit.Case, async: true

  alias EbbServer.Storage.SQLite
  alias Exqlite.Sqlite3
  import EbbServer.TestHelpers

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
      dir = tmp_dir(context)
      %{name: name} = start_sqlite(dir)

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
      dir = tmp_dir(context)
      %{name: name} = start_sqlite(dir)

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
      dir = tmp_dir(context)
      %{name: name} = start_sqlite(dir)

      assert :not_found = SQLite.get_entity("nonexistent", name)
    end
  end

  describe "get_entity_last_gsn" do
    test "returns the last_gsn for an existing entity", context do
      dir = tmp_dir(context)
      %{name: name} = start_sqlite(dir)

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
      dir = tmp_dir(context)
      %{name: name} = start_sqlite(dir)

      assert :not_found = SQLite.get_entity_last_gsn("nonexistent", name)
    end
  end

  describe "upsert replaces existing" do
    test "second upsert with same ID overwrites the first", context do
      dir = tmp_dir(context)
      %{name: name} = start_sqlite(dir)

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

    test "an older last_gsn does not overwrite a newer row", context do
      dir = tmp_dir(context)
      %{name: name} = start_sqlite(dir)

      newer = %{
        id: "todo_abc",
        type: "todo",
        data: ~s({"fields":{"title":{"value":"newer"}}}),
        created_hlc: 1000,
        updated_hlc: 3000,
        deleted_hlc: nil,
        deleted_by: nil,
        last_gsn: 3
      }

      older = %{
        newer
        | data: ~s({"fields":{"title":{"value":"older"}}}),
          updated_hlc: 2000,
          last_gsn: 2
      }

      :ok = SQLite.upsert_entity(newer, name)
      :ok = SQLite.upsert_entity(older, name)

      assert {:ok, result} = SQLite.get_entity("todo_abc", name)
      assert result.last_gsn == 3
      assert result.data == newer.data
      assert result.updated_hlc == 3000
    end

    test "an equal last_gsn still overwrites", context do
      dir = tmp_dir(context)
      %{name: name} = start_sqlite(dir)

      first = %{
        id: "todo_abc",
        type: "todo",
        data: ~s({"fields":{"title":{"value":"first"}}}),
        created_hlc: 1000,
        updated_hlc: 3000,
        deleted_hlc: nil,
        deleted_by: nil,
        last_gsn: 3
      }

      second = %{
        first
        | data: ~s({"fields":{"title":{"value":"second"}}}),
          updated_hlc: 3001
      }

      :ok = SQLite.upsert_entity(first, name)
      :ok = SQLite.upsert_entity(second, name)

      assert {:ok, result} = SQLite.get_entity("todo_abc", name)
      assert result.last_gsn == 3
      assert result.data == second.data
      assert result.updated_hlc == 3001
    end
  end

  describe "generated columns" do
    test "source_id and target_id are populated from JSON data", context do
      dir = tmp_dir(context)
      %{name: name} = start_sqlite(dir)

      entity = %{
        id: "rel_abc",
        type: "relation",
        data: ~s({"fields":{"source_id":{"value":"src_1"},"target_id":{"value":"tgt_1"}}}),
        created_hlc: 1000,
        updated_hlc: 1000,
        deleted_hlc: nil,
        deleted_by: nil,
        last_gsn: 1
      }

      :ok = SQLite.upsert_entity(entity, name)

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
