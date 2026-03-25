defmodule EbbServer.Storage.SchemaTest do
  use ExUnit.Case

  setup do
    # Open a fresh in-memory SQLite database for each test
    {:ok, db} = Exqlite.Sqlite3.open(":memory:")
    # Return it so each test can use it
    {:ok, db: db}
  end

  test "creates all expected tables", %{db: db} do
    EbbServer.Storage.Schema.initialize(db)
    # Query sqlite_master for table names
    {:ok, stmt} =
      Exqlite.Sqlite3.prepare(
        db,
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      )

    tables = collect_rows(stmt, db)

    expected = [
      "actions",
      "actors",
      "cold_action_index",
      "entities",
      "function_versions",
      "snapshots",
      "updates"
    ]

    assert tables == expected
  end

  test "initialize is idempotent", %{db: db} do
    EbbServer.Storage.Schema.initialize(db)
    EbbServer.Storage.Schema.initialize(db)
    # If we get here without an error, it passed
  end

  test "insert and read back Action + Update", %{db: db} do
    EbbServer.Storage.Schema.initialize(db)

    Exqlite.Sqlite3.execute(db, """
      INSERT INTO actions (id, actor_id, hlc, gsn, created_at)
      VALUES ('act_1', 'actor_1', 1000, 1, 1711036800000)
    """)

    Exqlite.Sqlite3.execute(db, """
      INSERT INTO updates (id, action_id, subject_id, subject_type, method, data)
      VALUES ('upd_1', 'act_1', 'todo_1', 'todo', 'PUT', '{"title":"Buy milk"}')
    """)

    {:ok, stmt} =
      Exqlite.Sqlite3.prepare(db, "SELECT id, actor_id, hlc, gsn FROM actions WHERE id = 'act_1'")

    {:row, row} = Exqlite.Sqlite3.step(db, stmt)
    assert row == ["act_1", "actor_1", 1000, 1]

    {:ok, stmt} =
      Exqlite.Sqlite3.prepare(
        db,
        "SELECT id, action_id, subject_id, subject_type, method, data FROM updates WHERE id = 'upd_1'"
      )

    {:row, row} = Exqlite.Sqlite3.step(db, stmt)
    assert row == ["upd_1", "act_1", "todo_1", "todo", "PUT", "{\"title\":\"Buy milk\"}"]
  end

  test "entity with Relationship data populates generated columns", %{db: db} do
    EbbServer.Storage.Schema.initialize(db)

    Exqlite.Sqlite3.execute(db, """
      INSERT INTO entities (id, type, data, created_hlc, updated_hlc, last_gsn)
      VALUES ('rel_1', 'relationship',
        '{"source_id":"todo_1","target_id":"grp_1","type":"todo","field":"list"}',
        1000, 1000, 1)
    """)

    {:ok, stmt} =
      Exqlite.Sqlite3.prepare(
        db,
        "SELECT source_id, target_id, rel_type, rel_field FROM entities WHERE id = 'rel_1'"
      )

    {:row, row} = Exqlite.Sqlite3.step(db, stmt)
    assert row == ["todo_1", "grp_1", "todo", "list"]
  end

  test "entity with GroupMember data populates generated columns", %{db: db} do
    EbbServer.Storage.Schema.initialize(db)

    Exqlite.Sqlite3.execute(db, """
      INSERT INTO entities (id, type, data, created_hlc, updated_hlc, last_gsn)
      VALUES ('gm_1', 'groupMember',
        '{"actor_id":"actor_1","group_id":"grp_1","permissions":"admin"}',
        1000, 1000, 1)
    """)

    {:ok, stmt} =
      Exqlite.Sqlite3.prepare(
        db,
        "SELECT actor_id, group_id, permissions FROM entities WHERE id = 'gm_1'"
      )

    {:row, row} = Exqlite.Sqlite3.step(db, stmt)
    assert row == ["actor_1", "grp_1", "admin"]
  end

  test "foreign key constraint rejects Update with non-existent action_id", %{db: db} do
    EbbServer.Storage.Schema.initialize(db)

    result =
      Exqlite.Sqlite3.execute(db, """
        INSERT INTO updates (id, action_id, subject_id, subject_type, method, data)
        VALUES ('upd_1', 'nonexistent', 'todo_1', 'todo', 'PUT', '{}')
      """)

    assert {:error, _reason} = result
  end

  # Helper to collect all rows from a prepared statement
  defp collect_rows(stmt, db) do
    collect_rows(stmt, db, [])
  end

  defp collect_rows(stmt, db, acc) do
    case Exqlite.Sqlite3.step(db, stmt) do
      {:row, [value]} -> collect_rows(stmt, db, acc ++ [value])
      :done -> acc
    end
  end
end
