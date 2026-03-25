defmodule EbbServer.Storage.ActionReaderTest do
  use ExUnit.Case

  setup do
    {:ok, db} = Exqlite.Sqlite3.open(":memory:")
    EbbServer.Storage.Schema.initialize(db)
    {:ok, writer} = EbbServer.Storage.ActionWriter.start_link(db: db)
    # Insert 3 known Actions
    {:ok, 1} =
      EbbServer.Storage.ActionWriter.append(writer, %{
        id: "act_1",
        actor_id: "actor_1",
        hlc: 1000,
        updates: [
          %{
            id: "upd_1a",
            subject_id: "entity_a",
            subject_type: "todo",
            method: "PUT",
            data: %{title: "First"}
          },
          %{
            id: "upd_1b",
            subject_id: "entity_b",
            subject_type: "todo",
            method: "PUT",
            data: %{title: "Second"}
          }
        ]
      })

    {:ok, 2} =
      EbbServer.Storage.ActionWriter.append(writer, %{
        id: "act_2",
        actor_id: "actor_1",
        hlc: 1001,
        updates: [
          %{
            id: "upd_2a",
            subject_id: "entity_a",
            subject_type: "todo",
            method: "PATCH",
            data: %{title: "Updated"}
          }
        ]
      })

    {:ok, 3} =
      EbbServer.Storage.ActionWriter.append(writer, %{
        id: "act_3",
        actor_id: "actor_1",
        hlc: 1002,
        updates: [
          %{
            id: "upd_3a",
            subject_id: "entity_c",
            subject_type: "todo",
            method: "PUT",
            data: %{title: "Third"}
          }
        ]
      })

    {:ok, db: db}
  end

  test "get_actions_since(0, 100) returns all 3 actions with nested updates", %{db: db} do
    actions = EbbServer.Storage.ActionReader.get_actions_since(db, 0, 100)
    assert length(actions) == 3
    assert Enum.map(actions, & &1.gsn) == [1, 2, 3]
    # First action should have 2 updates
    first = Enum.at(actions, 0)
    assert length(first.updates) == 2
  end

  test "get_actions_since(2, 100) returns only GSN 3 (exclusive cursor)", %{db: db} do
    actions = EbbServer.Storage.ActionReader.get_actions_since(db, 2, 100)
    assert length(actions) == 1
    assert Enum.at(actions, 0).gsn == 3
  end

  test "get_actions_since(0, 2) respects limit", %{db: db} do
    actions = EbbServer.Storage.ActionReader.get_actions_since(db, 0, 2)
    assert length(actions) == 2
    assert Enum.map(actions, & &1.gsn) == [1, 2]
  end

  test "get_actions_for_entities_since filters by entity", %{db: db} do
    actions =
      EbbServer.Storage.ActionReader.get_actions_for_entities_since(db, ["entity_a"], 0, 100)

    assert length(actions) == 2
    assert Enum.map(actions, & &1.id) == ["act_1", "act_2"]
  end

  test "filtered action includes ALL updates, not just matching ones", %{db: db} do
    actions =
      EbbServer.Storage.ActionReader.get_actions_for_entities_since(db, ["entity_a"], 0, 100)

    first = Enum.at(actions, 0)
    # act_1 has updates for entity_a AND entity_b — both should be present
    assert length(first.updates) == 2
  end

  test "get_action_at_gsn returns action with updates", %{db: db} do
    action = EbbServer.Storage.ActionReader.get_action_at_gsn(db, 2)
    assert action.id == "act_2"
    assert action.gsn == 2
    assert length(action.updates) == 1
  end

  test "get_action_at_gsn returns nil for non-existent GSN", %{db: db} do
    action = EbbServer.Storage.ActionReader.get_action_at_gsn(db, 99)
    assert action == nil
  end

  test "get_current_gsn returns highest GSN", %{db: db} do
    gsn = EbbServer.Storage.ActionReader.get_current_gsn(db)
    assert gsn == 3
  end

  test "get_low_water_mark returns 0 in MVP", %{db: db} do
    lwm = EbbServer.Storage.ActionReader.get_low_water_mark(db)
    assert lwm == 0
  end
end
