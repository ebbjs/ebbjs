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

  defp open_writable(dir) do
    path = Path.join(dir, "ebb.db")
    {:ok, db} = Sqlite3.open(path)

    on_exit(fn ->
      Sqlite3.close(db)
    end)

    db
  end

  defp entity_row(id, type, fields, overrides \\ %{}) do
    Map.merge(
      %{
        id: id,
        type: type,
        data: Jason.encode!(%{"fields" => fields}),
        created_hlc: 1000,
        updated_hlc: 1000,
        deleted_hlc: nil,
        deleted_by: nil,
        last_gsn: 1
      },
      overrides
    )
  end

  defp lww(value), do: %{"type" => "lww", "value" => value, "hlc" => 1}

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

  describe "query_entities window validation" do
    test "replies with an error instead of raising or rendering an unbounded query", context do
      dir = tmp_dir(context)
      %{name: name, pid: pid} = start_sqlite(dir)

      for query <- [
            %{type: "todo", filter: nil, actor_id: "a_1"},
            %{type: "todo", filter: nil, actor_id: "a_1", limit: nil},
            %{type: "todo", filter: nil, actor_id: "a_1", limit: -1},
            %{type: "todo", filter: nil, actor_id: "a_1", limit: "10"}
          ] do
        assert {:error, :invalid_limit} = SQLite.query_entities(query, name)
      end

      for offset <- [-1, 9_223_372_036_854_775_808] do
        assert {:error, :invalid_offset} =
                 SQLite.query_entities(
                   %{type: "todo", filter: nil, actor_id: "a_1", limit: 10, offset: offset},
                   name
                 )
      end

      assert Process.alive?(pid)
    end
  end

  describe "query_entities filter validation" do
    test "replies with invalid_filter and stays alive for every malformed shape", context do
      dir = tmp_dir(context)
      %{name: name, pid: pid} = start_sqlite(dir)

      for filter <- malformed_query_filters() do
        query = %{type: "todo", filter: filter, actor_id: "a_1", limit: 10}

        assert {:error, :invalid_filter} = SQLite.query_entities(query, name)
        assert Process.whereis(name) == pid
      end
    end
  end

  # Every tenant shares the one SQLite process, so a statement it refuses must
  # come back as a reply. These tests inject the failures SQLite and its NIF
  # actually produce — an unbinable parameter, a row it cannot evaluate, a
  # schema that no longer answers — instead of stubbing the driver (#626).
  describe "query path failure net (#626)" do
    defp doc_query do
      %{type: "doc", filter: nil, actor_id: "a_1", limit: 10}
    end

    # A document reachable through one shared group. The membership's
    # `permissions` value is what the query evaluates with json_array_length/1.
    defp seed_doc_graph(name, permissions_value, last_gsn) do
      :ok = SQLite.upsert_entity(entity_row("doc_1", "doc", %{"title" => lww("doc")}), name)

      :ok =
        SQLite.upsert_entity(
          entity_row("eg_1", "entityGroup", %{
            "entity_id" => lww("doc_1"),
            "group_id" => lww("g_1")
          }),
          name
        )

      :ok =
        SQLite.upsert_entity(
          entity_row(
            "gm_1",
            "groupMember",
            %{
              "actor_id" => lww("a_1"),
              "group_id" => lww("g_1"),
              "permissions" => lww(permissions_value)
            },
            %{last_gsn: last_gsn}
          ),
          name
        )
    end

    test "a parameter the NIF cannot bind replies instead of taking the cache down", context do
      dir = tmp_dir(context)
      %{name: name, pid: pid} = start_sqlite(dir)

      # A bignum has no SQLite representation: exqlite raises from the NIF while
      # binding rather than returning an error tuple, so only the rescue in
      # run_prepared/3 keeps this request from becoming a process exit.
      assert {:error, %ArgumentError{}} =
               SQLite.query_entities(
                 %{doc_query() | actor_id: 9_223_372_036_854_775_808},
                 name
               )

      assert Process.whereis(name) == pid
      assert :ok = SQLite.health(name)
    end

    test "a row SQLite cannot evaluate replies, and the cache serves once it is repaired",
         context do
      dir = tmp_dir(context)
      %{name: name, pid: pid} = start_sqlite(dir)

      # A membership materialized with a bare string where the permission list
      # belongs makes json_array_length/1 fail during step.
      :ok = seed_doc_graph(name, "not-an-array", 1)

      assert {:error, reason} = SQLite.query_entities(doc_query(), name)
      assert reason =~ "malformed JSON"
      assert Process.whereis(name) == pid

      :ok = seed_doc_graph(name, ["read"], 2)

      assert {:ok, [%{id: "doc_1"}]} = SQLite.query_entities(doc_query(), name)
    end

    test "a schema that no longer answers replies, and the cache serves once it returns",
         context do
      dir = tmp_dir(context)
      %{name: name, pid: pid} = start_sqlite(dir)

      :ok = seed_doc_graph(name, ["read"], 1)
      assert {:ok, [%{id: "doc_1"}]} = SQLite.query_entities(doc_query(), name)

      db = open_writable(dir)
      :ok = Sqlite3.execute(db, "ALTER TABLE entities RENAME TO entities_gone")

      # The statement compiles against the schema the process already has, so
      # the missing table surfaces on step; that error expires the schema, which
      # is what makes the following attempt fail in prepare.
      assert {:error, step_reason} = SQLite.query_entities(doc_query(), name)
      assert step_reason =~ "no such table"

      assert {:error, prepare_reason} = SQLite.query_entities(doc_query(), name)
      assert prepare_reason =~ "no such table"

      assert Process.whereis(name) == pid

      :ok = Sqlite3.execute(db, "ALTER TABLE entities_gone RENAME TO entities")

      assert {:ok, [%{id: "doc_1"}]} = SQLite.query_entities(doc_query(), name)
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

  describe "patch_entity/4" do
    defp seed_entity(name, id, data, last_gsn \\ 1) do
      :ok =
        SQLite.upsert_entity(
          %{
            id: id,
            type: "doc",
            data: data,
            created_hlc: 1000,
            updated_hlc: 1000,
            deleted_hlc: nil,
            deleted_by: nil,
            last_gsn: last_gsn
          },
          name
        )
    end

    test "patches one key while sibling and top-level data keys survive", context do
      dir = tmp_dir(context)
      %{name: name} = start_sqlite(dir)

      seed_entity(
        name,
        "doc_1",
        ~s({"fields":{"title":{"value":"old","hlc":1},"done":{"value":false,"hlc":1}},"meta":{"v":1}})
      )

      :ok =
        SQLite.patch_entity(
          "doc_1",
          %{"title" => ~s({"value":"new","hlc":2})},
          %{type: "doc", updated_hlc: 2000, deleted_hlc: nil, deleted_by: nil, last_gsn: 2},
          name
        )

      assert {:ok, row} = SQLite.get_entity("doc_1", name)
      data = Jason.decode!(row.data)

      assert data["fields"]["title"] == %{"value" => "new", "hlc" => 2}
      assert data["fields"]["done"] == %{"value" => false, "hlc" => 1}
      assert data["meta"] == %{"v" => 1}
    end

    test "updates the metadata columns without touching created_hlc", context do
      dir = tmp_dir(context)
      %{name: name} = start_sqlite(dir)

      seed_entity(name, "doc_1", ~s({"fields":{"title":{"value":"old","hlc":1}}}))

      :ok =
        SQLite.patch_entity(
          "doc_1",
          %{"title" => ~s({"value":"new","hlc":2})},
          %{
            type: "todo",
            updated_hlc: 3000,
            deleted_hlc: 4000,
            deleted_by: "actor_9",
            last_gsn: 3
          },
          name
        )

      assert {:ok, row} = SQLite.get_entity("doc_1", name)
      assert row.type == "todo"
      assert row.created_hlc == 1000
      assert row.updated_hlc == 3000
      assert row.deleted_hlc == 4000
      assert row.deleted_by == "actor_9"
      assert row.last_gsn == 3
    end

    test "a lower last_gsn is rejected and leaves the row unchanged", context do
      dir = tmp_dir(context)
      %{name: name} = start_sqlite(dir)

      seed_entity(name, "doc_1", ~s({"fields":{"title":{"value":"first","hlc":1}}}), 5)

      :ok =
        SQLite.patch_entity(
          "doc_1",
          %{"title" => ~s({"value":"stale","hlc":9})},
          %{type: "doc", updated_hlc: 1000, deleted_hlc: nil, deleted_by: nil, last_gsn: 3},
          name
        )

      assert {:ok, row} = SQLite.get_entity("doc_1", name)
      assert row.last_gsn == 5
      assert row.updated_hlc == 1000
      assert Jason.decode!(row.data)["fields"]["title"]["value"] == "first"
    end

    test "an equal last_gsn still applies", context do
      dir = tmp_dir(context)
      %{name: name} = start_sqlite(dir)

      seed_entity(name, "doc_1", ~s({"fields":{"title":{"value":"first","hlc":1}}}), 5)

      :ok =
        SQLite.patch_entity(
          "doc_1",
          %{"title" => ~s({"value":"second","hlc":6})},
          %{type: "doc", updated_hlc: 6000, deleted_hlc: nil, deleted_by: nil, last_gsn: 5},
          name
        )

      assert {:ok, row} = SQLite.get_entity("doc_1", name)
      assert row.last_gsn == 5
      assert row.updated_hlc == 6000
      assert Jason.decode!(row.data)["fields"]["title"]["value"] == "second"
    end

    test "empty fields performs a metadata-only update", context do
      dir = tmp_dir(context)
      %{name: name} = start_sqlite(dir)

      seed_entity(name, "doc_1", ~s({"fields":{"title":{"value":"kept","hlc":1}}}), 2)

      :ok =
        SQLite.patch_entity(
          "doc_1",
          %{},
          %{
            type: "doc",
            updated_hlc: 7000,
            deleted_hlc: 7000,
            deleted_by: "actor_1",
            last_gsn: 7
          },
          name
        )

      assert {:ok, row} = SQLite.get_entity("doc_1", name)
      assert row.last_gsn == 7
      assert row.updated_hlc == 7000
      assert row.deleted_hlc == 7000
      assert row.deleted_by == "actor_1"
      assert Jason.decode!(row.data)["fields"]["title"]["value"] == "kept"
    end

    test "a patched nested map key survives alongside its siblings", context do
      dir = tmp_dir(context)
      %{name: name} = start_sqlite(dir)

      seed_entity(
        name,
        "doc_1",
        ~s({"fields":{"content":{"map":{"a":{"value":1,"hlc":1},"b":{"value":2,"hlc":1}}}}})
      )

      :ok =
        SQLite.patch_entity(
          "doc_1",
          %{"content.map.\"b\"" => ~s({"value":9,"hlc":2})},
          %{type: "doc", updated_hlc: 2000, deleted_hlc: nil, deleted_by: nil, last_gsn: 2},
          name
        )

      assert {:ok, row} = SQLite.get_entity("doc_1", name)
      content = Jason.decode!(row.data)["fields"]["content"]

      assert content["map"]["a"] == %{"value" => 1, "hlc" => 1}
      assert content["map"]["b"] == %{"value" => 9, "hlc" => 2}
    end

    test "a patched nested map value round-trips through json_extract", context do
      dir = tmp_dir(context)
      %{name: name} = start_sqlite(dir)

      seed_entity(
        name,
        "doc_1",
        ~s({"fields":{"content":{"map":{}},"source_id":{"value":"src_old","hlc":1}}})
      )

      :ok =
        SQLite.patch_entity(
          "doc_1",
          %{
            "content" => ~s({"map":{"run_1":{"value":"z","hlc":9}}}),
            "source_id" => ~s({"value":"src_new","hlc":2})
          },
          %{type: "doc", updated_hlc: 2000, deleted_hlc: nil, deleted_by: nil, last_gsn: 2},
          name
        )

      assert {:ok, row} = SQLite.get_entity("doc_1", name)
      assert Jason.decode!(row.data)["fields"]["content"]["map"]["run_1"]["value"] == "z"

      db = open_readonly(dir)

      {:ok, stmt} =
        Sqlite3.prepare(
          db,
          "SELECT json_extract(data, '$.fields.content.map.run_1.value'), source_id FROM entities WHERE id = ?"
        )

      :ok = Sqlite3.bind(stmt, ["doc_1"])
      assert {:row, ["z", "src_new"]} = Sqlite3.step(db, stmt)
      :ok = Sqlite3.release(db, stmt)
    end
  end

  describe "cursors" do
    test "get_cursor returns :not_found for a missing name", context do
      dir = tmp_dir(context)
      %{name: name} = start_sqlite(dir)

      assert :not_found = SQLite.get_cursor("action_export", name)
    end

    test "put_cursor then get_cursor round-trips", context do
      dir = tmp_dir(context)
      %{name: name} = start_sqlite(dir)

      assert :ok = SQLite.put_cursor("action_export", 42, name)
      assert {:ok, 42} = SQLite.get_cursor("action_export", name)
    end

    test "put_cursor upserts and advances the value", context do
      dir = tmp_dir(context)
      %{name: name} = start_sqlite(dir)

      assert :ok = SQLite.put_cursor("action_export", 42, name)
      assert :ok = SQLite.put_cursor("action_export", 43, name)
      assert {:ok, 43} = SQLite.get_cursor("action_export", name)
    end

    test "cursors are independent by name", context do
      dir = tmp_dir(context)
      %{name: name} = start_sqlite(dir)

      assert :ok = SQLite.put_cursor("action_export", 1, name)
      assert :ok = SQLite.put_cursor("other_consumer", 99, name)

      assert {:ok, 1} = SQLite.get_cursor("action_export", name)
      assert {:ok, 99} = SQLite.get_cursor("other_consumer", name)
    end

    test "a cursor survives a SQLite restart", context do
      dir = tmp_dir(context)
      %{name: name, pid: pid} = start_sqlite(dir)

      :ok = SQLite.put_cursor("action_export", 7, name)
      safe_stop(pid)

      %{name: restarted} = start_sqlite(dir)

      assert {:ok, 7} = SQLite.get_cursor("action_export", restarted)
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

  describe "group listing queries" do
    test "lists group members in (actor_id, id) order and never skips a tie", context do
      dir = tmp_dir(context)
      %{name: name} = start_sqlite(dir)

      for {id, actor_id, group_id} <- [
            {"gm_b", "a_1", "g_1"},
            {"gm_a", "a_1", "g_1"},
            {"gm_c", "a_2", "g_1"},
            {"gm_other", "a_0", "g_2"}
          ] do
        :ok =
          SQLite.upsert_entity(
            entity_row(id, "groupMember", %{
              "actor_id" => lww(actor_id),
              "group_id" => lww(group_id)
            }),
            name
          )
      end

      :ok =
        SQLite.upsert_entity(
          entity_row(
            "gm_deleted",
            "groupMember",
            %{"actor_id" => lww("a_0"), "group_id" => lww("g_1")},
            %{deleted_hlc: 5, deleted_by: "a_1"}
          ),
          name
        )

      assert SQLite.list_group_members("g_1", nil, 10, name) == [
               {"gm_a", "a_1"},
               {"gm_b", "a_1"},
               {"gm_c", "a_2"}
             ]

      # The pair, not the actor id alone, is the keyset: resuming after the
      # first of two rows that share an actor still returns the second.
      assert SQLite.list_group_members("g_1", {"a_1", "gm_a"}, 10, name) == [
               {"gm_b", "a_1"},
               {"gm_c", "a_2"}
             ]

      assert SQLite.list_group_members("g_1", nil, 1, name) == [{"gm_a", "a_1"}]
    end

    test "lists entityGroup memberships by row id, excluding tombstones", context do
      dir = tmp_dir(context)
      %{name: name} = start_sqlite(dir)

      for {id, entity_id} <- [{"eg_2", "todo_2"}, {"eg_1", "todo_1"}, {"eg_9", "todo_9"}] do
        :ok =
          SQLite.upsert_entity(
            entity_row(id, "entityGroup", %{
              "entity_id" => lww(entity_id),
              "group_id" => lww("g_1")
            }),
            name
          )
      end

      :ok =
        SQLite.upsert_entity(
          entity_row(
            "eg_3",
            "entityGroup",
            %{"entity_id" => lww("todo_3"), "group_id" => lww("g_1")},
            %{deleted_hlc: 5, deleted_by: "a_1"}
          ),
          name
        )

      assert SQLite.list_entity_group_memberships("g_1", nil, 10, name) == [
               {"eg_1", "todo_1"},
               {"eg_2", "todo_2"},
               {"eg_9", "todo_9"}
             ]

      assert SQLite.list_entity_group_memberships("g_1", "eg_1", 10, name) == [
               {"eg_2", "todo_2"},
               {"eg_9", "todo_9"}
             ]
    end

    test "fetches live rows by id and omits tombstones", context do
      dir = tmp_dir(context)
      %{name: name} = start_sqlite(dir)

      :ok = SQLite.upsert_entity(entity_row("todo_1", "todo", %{"title" => lww("a")}), name)

      :ok =
        SQLite.upsert_entity(
          entity_row("todo_2", "todo", %{"title" => lww("b")}, %{
            deleted_hlc: 5,
            deleted_by: "a_1"
          }),
          name
        )

      assert [row] = SQLite.get_entities(["todo_1", "todo_2", "todo_missing"], name)
      assert row.id == "todo_1"
      assert row.type == "todo"
      assert Jason.decode!(row.data) == %{"fields" => %{"title" => lww("a")}}

      assert SQLite.get_entities([], name) == []
    end
  end
end
