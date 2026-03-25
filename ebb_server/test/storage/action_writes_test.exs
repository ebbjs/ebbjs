defmodule EbbServer.Storage.ActionWriterTest do
  use ExUnit.Case

  setup do
    {:ok, db} = Exqlite.Sqlite3.open(":memory:")
    EbbServer.Storage.Schema.initialize(db)
    # Start a Writer process for this test
    {:ok, pid} = EbbServer.Storage.ActionWriter.start_link(db: db)
    {:ok, db: db, writer: pid}
  end

  test "append a single Action, verify GSN starts at 1", %{writer: writer, db: db} do
    action = %{
      id: "act_1",
      actor_id: "actor_1",
      hlc: 1000,
      updates: [
        %{
          id: "upd_1",
          subject_id: "todo_1",
          subject_type: "todo",
          method: "PUT",
          data: %{title: "Buy milk"}
        }
      ]
    }

    {:ok, gsn} = EbbServer.Storage.ActionWriter.append(writer, action)
    assert gsn == 1
  end

  test "three sequential appends get GSNs 1, 2, 3", %{writer: writer} do
    action1 = %{
      id: "act_1",
      actor_id: "actor_1",
      hlc: 1000,
      updates: [
        %{
          id: "upd_1",
          subject_id: "todo_1",
          subject_type: "todo",
          method: "PUT",
          data: %{title: "One"}
        }
      ]
    }

    action2 = %{
      id: "act_2",
      actor_id: "actor_1",
      hlc: 1001,
      updates: [
        %{
          id: "upd_2",
          subject_id: "todo_2",
          subject_type: "todo",
          method: "PUT",
          data: %{title: "Two"}
        }
      ]
    }

    action3 = %{
      id: "act_3",
      actor_id: "actor_1",
      hlc: 1002,
      updates: [
        %{
          id: "upd_3",
          subject_id: "todo_3",
          subject_type: "todo",
          method: "PUT",
          data: %{title: "Three"}
        }
      ]
    }

    {:ok, gsn1} = EbbServer.Storage.ActionWriter.append(writer, action1)
    {:ok, gsn2} = EbbServer.Storage.ActionWriter.append(writer, action2)
    {:ok, gsn3} = EbbServer.Storage.ActionWriter.append(writer, action3)
    assert gsn1 == 1
    assert gsn2 == 2
    assert gsn3 == 3
  end

  test "updates are written with correct action_id foreign keys", %{writer: writer, db: db} do
    action = %{
      id: "act_1",
      actor_id: "actor_1",
      hlc: 1000,
      updates: [
        %{
          id: "upd_1",
          subject_id: "todo_1",
          subject_type: "todo",
          method: "PUT",
          data: %{title: "Buy milk"}
        },
        %{
          id: "upd_2",
          subject_id: "todo_2",
          subject_type: "todo",
          method: "PUT",
          data: %{title: "Buy eggs"}
        }
      ]
    }

    {:ok, _gsn} = EbbServer.Storage.ActionWriter.append(writer, action)
    {:ok, stmt} = Exqlite.Sqlite3.prepare(db, "SELECT id, action_id FROM updates ORDER BY id")
    {:row, row1} = Exqlite.Sqlite3.step(db, stmt)
    {:row, row2} = Exqlite.Sqlite3.step(db, stmt)
    assert row1 == ["upd_1", "act_1"]
    assert row2 == ["upd_2", "act_1"]
  end

  test "GSN continues after restart", %{db: db} do
    # First Writer session
    {:ok, writer1} = EbbServer.Storage.ActionWriter.start_link(db: db)

    action1 = %{
      id: "act_1",
      actor_id: "actor_1",
      hlc: 1000,
      updates: [
        %{
          id: "upd_1",
          subject_id: "todo_1",
          subject_type: "todo",
          method: "PUT",
          data: %{title: "One"}
        }
      ]
    }

    {:ok, 1} = EbbServer.Storage.ActionWriter.append(writer1, action1)
    GenServer.stop(writer1)
    # Second Writer session — GSN should continue from 2
    {:ok, writer2} = EbbServer.Storage.ActionWriter.start_link(db: db)

    action2 = %{
      id: "act_2",
      actor_id: "actor_1",
      hlc: 1001,
      updates: [
        %{
          id: "upd_2",
          subject_id: "todo_2",
          subject_type: "todo",
          method: "PUT",
          data: %{title: "Two"}
        }
      ]
    }

    {:ok, gsn} = EbbServer.Storage.ActionWriter.append(writer2, action2)
    assert gsn == 2
  end

  test "subscribers receive batch_flushed notification", %{writer: writer} do
    EbbServer.Storage.ActionWriter.subscribe(writer, self())

    action = %{
      id: "act_1",
      actor_id: "actor_1",
      hlc: 1000,
      updates: [
        %{
          id: "upd_1",
          subject_id: "todo_1",
          subject_type: "todo",
          method: "PUT",
          data: %{title: "One"}
        }
      ]
    }

    {:ok, 1} = EbbServer.Storage.ActionWriter.append(writer, action)
    assert_receive {:batch_flushed, 1, 1}
  end
end
