defmodule EbbServer.Sync.GroupListingTest do
  @moduledoc """
  Behavioral tests for the group-scoped cold-bootstrap listing (#476).

  The contract: one page of a group's state as of one resolution frontier,
  keyset-paged, with every row materialized as it is read.
  """

  use ExUnit.Case, async: false
  use EbbServer.Integration.StorageCase, with_auth_mode: true

  import Plug.Conn
  import Plug.Test
  import EbbServer.Integration.ActionHelpers
  import EbbServer.TestHelpers

  alias EbbServer.Storage.{DirtyTracker, RocksDB, SQLite, SystemComponent, WatermarkTracker}
  alias EbbServer.Sync.{CatchUp, GroupListing, Router}

  @entity_keys ["created_hlc", "data", "deleted_hlc", "id", "last_gsn", "model", "updated_hlc"]

  describe "GET /sync/groups/:group_id/entities" do
    test "returns the envelope and rows shape-identical to GET /entities/:id", %{tmp_dir: _} do
      actor_id = unique("a")
      group_id = unique("g")
      bootstrap(actor_id, group_id)

      [{todo_a, eg_a, _}, {todo_b, eg_b, _}] = write_todos(actor_id, group_id, 2)

      conn = get_listing(group_id, actor_id)
      assert conn.status == 200

      page = Jason.decode!(conn.resp_body)

      assert page |> Map.keys() |> Enum.sort() ==
               ["cursor", "entities", "group_id", "has_more", "watermark"]

      assert page["group_id"] == group_id
      assert is_integer(page["watermark"])
      assert page["has_more"] == false
      assert page["cursor"] == nil

      entities = page["entities"]
      ids = Enum.map(entities, & &1["id"])

      # The row set is the group's state: the group row and its grant rows
      # carry no membership row, so a membership join alone misses them.
      assert Enum.count(entities, &carries?(&1, :group)) == 1
      assert group_id in ids

      assert Enum.count(entities, &carries?(&1, :grant)) == 1

      assert Enum.count(entities, &carries?(&1, :membership)) == 2

      assert Enum.sort(ids) ==
               Enum.sort([group_id, grant_id(entities), todo_a, todo_b, eg_a, eg_b])

      for entity <- entities do
        assert entity |> Map.keys() |> Enum.sort() == @entity_keys
      end

      # `GET /entities/:id` authorizes through membership rows, so it cannot
      # read the system rows themselves (a group or grant row has no
      # membership row behind it). Every user entity it can read must be
      # byte-identical to the seeded object.
      for entity <- entities, entity["type"] == "todo" do
        read = get_entity(entity["id"], actor_id)
        assert read.status == 200
        assert Jason.decode!(read.resp_body) == entity
      end
    end

    test "403 not_member for a non-member and for an unknown group", %{tmp_dir: _} do
      owner_id = unique("a")
      group_id = unique("g")
      bootstrap(owner_id, group_id)

      outsider_id = unique("a")

      non_member = get_listing(group_id, outsider_id)
      assert non_member.status == 403
      assert Jason.decode!(non_member.resp_body) == %{"error" => "not_member"}

      unknown_group = get_listing(unique("g_missing"), owner_id)
      assert unknown_group.status == 403
      assert Jason.decode!(unknown_group.resp_body) == %{"error" => "not_member"}
    end

    test "limit defaults to 200, caps at 1000, and rejects anything else", %{tmp_dir: _} do
      actor_id = unique("a")
      group_id = unique("g")
      bootstrap(actor_id, group_id)
      write_todos(actor_id, group_id, 1)

      assert {:ok, default_page} = GroupListing.list(group_id, actor_id)
      assert {:ok, explicit_page} = GroupListing.list(group_id, actor_id, limit: 200)
      assert default_page == explicit_page

      assert {:ok, %{has_more: false}} = GroupListing.list(group_id, actor_id, limit: 1000)
      assert {:error, :invalid_limit} = GroupListing.list(group_id, actor_id, limit: 1001)
      assert {:error, :invalid_limit} = GroupListing.list(group_id, actor_id, limit: 0)

      for bad <- ["0", "-1", "abc", "1.5", ""] do
        conn = get_listing(group_id, actor_id, %{"limit" => bad})
        assert conn.status == 400
        assert Jason.decode!(conn.resp_body) == %{"error" => "invalid_limit"}
      end

      assert get_listing(group_id, actor_id, %{"limit" => "1001"}).status == 400
      assert get_listing(group_id, actor_id, %{"limit" => "1000"}).status == 200
    end

    test "omits a deleted entity but keeps its live membership row", %{tmp_dir: _} do
      actor_id = unique("a")
      group_id = unique("g")
      bootstrap(actor_id, group_id)

      [{kept_id, _kept_eg, _}, {deleted_id, deleted_eg, _}] =
        write_todos(actor_id, group_id, 2)

      assert write_delete(actor_id, deleted_id).status == 200

      {:ok, page} = GroupListing.list(group_id, actor_id)
      ids = Enum.map(page.entities, & &1.id)

      assert kept_id in ids
      refute deleted_id in ids
      # The membership row itself is still live; only the entity is tombstoned.
      assert deleted_eg in ids
    end

    test "pages on the membership key and round-trips the cursor", %{tmp_dir: _} do
      actor_id = unique("a")
      group_id = unique("g")
      bootstrap(actor_id, group_id)
      write_todos(actor_id, group_id, 3)

      {:ok, single_page} = GroupListing.list(group_id, actor_id)
      {:ok, page1} = GroupListing.list(group_id, actor_id, limit: 4)

      assert page1.has_more
      assert is_binary(page1.cursor)
      assert page1.watermark == single_page.watermark

      {:ok, page2} = GroupListing.list(group_id, actor_id, limit: 4, cursor: page1.cursor)
      assert page2.has_more == false
      assert page2.cursor == nil
      assert page2.watermark == page1.watermark

      ids = fn page -> Enum.map(page.entities, & &1.id) end
      listed = ids.(page1) ++ ids.(page2)

      assert length(listed) == length(Enum.uniq(listed))
      assert Enum.sort(listed) == Enum.sort(ids.(single_page))

      # The cursor is a stable keyset, not an offset: walking with any limit
      # yields the same rows, including a page the bounded prefix alone fills.
      for limit <- [1, 2, 3, 4, 100] do
        walked = collect_pages(group_id, actor_id, limit, nil, [])
        assert Enum.sort(Enum.map(walked, & &1.id)) == Enum.sort(ids.(single_page))
      end

      # A cursor from another group is a bad cursor, not a foreign page.
      other_group_id = unique("g")
      bootstrap(actor_id, other_group_id)

      mismatched = get_listing(other_group_id, actor_id, %{"cursor" => page1.cursor})
      assert mismatched.status == 400
      assert Jason.decode!(mismatched.resp_body) == %{"error" => "bad_cursor"}

      assert get_listing(group_id, actor_id, %{"cursor" => "not-a-token"}).status == 400

      shape_only =
        %{"v" => 1, "group_id" => group_id, "w" => 0, "key" => ["nope"]}
        |> Jason.encode!()
        |> Base.url_encode64(padding: false)

      assert get_listing(group_id, actor_id, %{"cursor" => shape_only}).status == 400
    end
  end

  describe "GET /sync/groups/:group_id/entities — the memberships keyset" do
    test "pages the memberships keyset to its last row, exactly once", %{tmp_dir: _} do
      actor_id = unique("a")
      group_id = unique("g")
      bootstrap(actor_id, group_id)
      write_todos(actor_id, group_id, 5)

      {:ok, unpaged} = GroupListing.list(group_id, actor_id)
      expected_ids = unpaged.entities |> Enum.map(& &1.id) |> Enum.sort()

      # Three membership keys per page: the group row plus the single grant
      # row do not fill page 1, so it continues into the
      # `memberships` phase and every page after it carries that key.
      pages = walk_pages(group_id, actor_id, 3)

      assert length(pages) == 3

      # `W` is read once, before the first row, and every page echoes it.
      for page <- pages, do: assert(page.watermark == unpaged.watermark)

      assert Enum.all?(Enum.drop(pages, -1), & &1.has_more)
      assert List.last(pages).has_more == false
      assert List.last(pages).cursor == nil

      listed = Enum.flat_map(pages, fn page -> Enum.map(page.entities, & &1.id) end)
      assert length(listed) == length(Enum.uniq(listed))
      assert Enum.sort(listed) == expected_ids

      # The cursor is the last membership row the page emitted, not an offset:
      # it round-trips through `[1, id]` and the next page resumes after it.
      for page <- Enum.drop(pages, -1) do
        assert cursor_key(page.cursor) == [1, last_membership_id(page)]
      end
    end

    test "resumes at the memberships phase from its own cursor token", %{tmp_dir: _} do
      actor_id = unique("a")
      group_id = unique("g")
      bootstrap(actor_id, group_id)
      write_todos(actor_id, group_id, 2)

      {:ok, unpaged} = GroupListing.list(group_id, actor_id)

      memberships =
        unpaged.entities
        |> Enum.reject(&(carries?(&1, :group) or carries?(&1, :grant)))
        |> Enum.map(& &1.id)
        |> Enum.sort()

      conn =
        get_listing(group_id, actor_id, %{
          "cursor" => cursor_token(group_id, unpaged.watermark, [1])
        })

      assert conn.status == 200
      page = Jason.decode!(conn.resp_body)

      # A memberships key resumes past the bounded prefix, so the group and
      # grant rows that only page 1 carries are not re-emitted.
      refute Enum.any?(page["entities"], &carries?(&1, :group))
      refute Enum.any?(page["entities"], &carries?(&1, :grant))

      assert Enum.sort(Enum.map(page["entities"], & &1["id"])) == memberships
      assert page["has_more"] == false
      assert page["cursor"] == nil
    end

    test "terminates when the bounded prefix fills the page", %{tmp_dir: _} do
      actor_id = unique("a")
      group_id = unique("g")
      bootstrap(actor_id, group_id)

      # The group row and its single grant row are the whole group, so page 1
      # ends with a next key in hand and nothing after it.
      {:ok, page} = GroupListing.list(group_id, actor_id, limit: 2)

      assert [group_row, grant_row] = page.entities
      assert carries?(group_row, :group)
      assert carries?(grant_row, :grant)
      assert page.has_more == false
      assert page.cursor == nil
    end

    test "rejects a cursor that is not a string", %{tmp_dir: _} do
      actor_id = unique("a")
      group_id = unique("g")
      bootstrap(actor_id, group_id)

      conn = get_listing(group_id, actor_id, %{"cursor[]" => "x"})

      assert conn.status == 400
      assert Jason.decode!(conn.resp_body) == %{"error" => "bad_cursor"}
    end
  end

  # An edge is a keyed component of its source (decision 13), so it ships
  # inside the row it belongs to rather than as a row the listing has to
  # enumerate separately.
  describe "GET /sync/groups/:group_id/entities — edges ride their source" do
    test "a source's edge ships with the source row, at any page limit", %{tmp_dir: _} do
      actor_id = unique("a")
      group_id = unique("g")
      bootstrap(actor_id, group_id, ["todo.*", "ebb/link.*"])

      [{todo_id, _eg_id, _}] = write_todos(actor_id, group_id, 1)

      type = unique("todo")
      target_id = unique("doc")

      write_action(actor_id, [link_update(todo_id, "assignee", type, target_id)])

      {:ok, page} = GroupListing.list(group_id, actor_id)

      ids = Enum.map(page.entities, & &1.id)
      assert todo_id in ids

      # The edge is one field of the row, keyed by accessor, type and target.
      source = Enum.find(page.entities, &(&1.id == todo_id))

      assert %{
               "map" => %{
                 "assignee" => %{"map" => %{^type => %{"map" => %{^target_id => leaf}}}}
               }
             } = fields_of(source)[SystemComponent.field(:link)]

      assert leaf["value"] == true

      # Paging cannot separate them: every page that carries the source
      # carries its edges, because there is nothing else to carry.
      pages = walk_pages(group_id, actor_id, 1)

      for page <- pages,
          row <- page.entities,
          row.id == todo_id do
        assert fields_of(row)[SystemComponent.field(:link)]
      end
    end

    # An edge's visibility is its source's membership, not the group the edge
    # was written in, so a move carries the edge and leaves nothing behind
    # (#789).
    test "a source moving between groups takes its edge and leaves no stale one", %{
      tmp_dir: _
    } do
      actor_id = unique("a")
      g1 = unique("g")
      g2 = unique("g")
      bootstrap(actor_id, g1, ["todo.*", "ebb/link.*"])
      bootstrap(actor_id, g2, ["todo.*", "ebb/link.*"])

      [{todo_id, eg1, _}] = write_todos(actor_id, g1, 1)

      type = unique("todo")
      target_id = unique("doc")

      write_action(actor_id, [link_update(todo_id, "assignee", type, target_id)])

      # Add the new membership before removing the old one, so the entity
      # never resolves to zero groups.
      write_action(actor_id, [
        membership_component_update(todo_id, g2, generate_hlc(), "eg_" <> todo_id <> "_" <> g2)
      ])

      write_action(actor_id, [membership_delete_update(eg1)])

      # The old group keeps its rows, not the moved source or its edge.
      {:ok, old_page} = GroupListing.list(g1, actor_id)
      refute Enum.any?(old_page.entities, &(&1.id == todo_id))
      refute target_id in Enum.flat_map(old_page.entities, &link_target_ids/1)

      # The new group ships the source row with its edge inside it.
      {:ok, new_page} = GroupListing.list(g2, actor_id)
      moved = Enum.find(new_page.entities, &(&1.id == todo_id))

      assert moved != nil
      assert moved.model == "todo"

      assert %{
               "map" => %{
                 "assignee" => %{"map" => %{^type => %{"map" => %{^target_id => leaf}}}}
               }
             } = fields_of(moved)[SystemComponent.field(:link)]

      assert leaf["value"] == true
    end
  end

  describe "GET /sync/groups/:group_id/entities — rows the cache cannot serve" do
    test "keeps the page when the group row is gone", %{tmp_dir: _} do
      actor_id = unique("a")
      group_id = unique("g")
      bootstrap(actor_id, group_id)
      [{todo_id, eg_id, _}] = write_todos(actor_id, group_id, 1)

      {:ok, _seeded} = GroupListing.list(group_id, actor_id)

      # A group row whose tombstone the cache never applied. Its membership
      # rows are still readable, so the page must not fail on the missing row.
      patch_cached_row(group_id, %{deleted_hlc: generate_hlc(), deleted_by: actor_id})

      conn = get_listing(group_id, actor_id)
      assert conn.status == 200

      page = Jason.decode!(conn.resp_body)
      refute Enum.any?(page["entities"], &carries?(&1, :group))

      assert Enum.sort(Enum.map(page["entities"], & &1["id"])) ==
               Enum.sort([grant_id(page["entities"]), eg_id, todo_id])
    end

    test "keeps the page when the group id is not a group row", %{tmp_dir: _} do
      actor_id = unique("a")
      group_id = unique("g")
      bootstrap(actor_id, group_id)
      [{todo_id, eg_id, _}] = write_todos(actor_id, group_id, 1)

      {:ok, _seeded} = GroupListing.list(group_id, actor_id)

      # The cache says the id is a todo; the membership rows still say the
      # actor is in the group. Only a row carrying `ebb/group` is the
      # listing's own row.
      patch_cached_data(group_id, %{
        "type" => "lww",
        "value" => "not a group",
        "hlc" => generate_hlc()
      })

      conn = get_listing(group_id, actor_id)
      assert conn.status == 200

      page = Jason.decode!(conn.resp_body)

      refute Enum.any?(page["entities"], &(&1["id"] == group_id))

      assert Enum.sort(Enum.map(page["entities"], & &1["id"])) ==
               Enum.sort([grant_id(page["entities"]), eg_id, todo_id])
    end

    test "answers 503 when the group row cannot be materialized", %{tmp_dir: _} do
      actor_id = unique("a")
      group_id = unique("g")
      bootstrap(actor_id, group_id)

      {:ok, _seeded} = GroupListing.list(group_id, actor_id)
      break_log(group_id)

      conn = get_listing(group_id, actor_id)

      assert conn.status == 503
      assert Jason.decode!(conn.resp_body) == %{"error" => "materialization_failed"}
    end

    test "answers 503 when a listed row cannot be materialized", %{tmp_dir: _} do
      actor_id = unique("a")
      group_id = unique("g")
      bootstrap(actor_id, group_id)
      [{todo_id, _eg_id, _}] = write_todos(actor_id, group_id, 1)

      {:ok, _seeded} = GroupListing.list(group_id, actor_id)
      break_log(todo_id)

      conn = get_listing(group_id, actor_id)

      assert conn.status == 503
      assert Jason.decode!(conn.resp_body) == %{"error" => "materialization_failed"}
    end

    test "skips a member row the log has since deleted", %{tmp_dir: _} do
      owner_id = unique("a")
      group_id = unique("g")
      bootstrap(owner_id, group_id, ["todo.*", "ebb/grant.*"])
      [{todo_id, eg_id, _}] = write_todos(owner_id, group_id, 1)

      member_id = unique("a")
      assert add_member(owner_id, group_id, member_id, ["todo.read"]).status == 200

      {:ok, seeded} = GroupListing.list(group_id, owner_id)
      member_row_id = member_row_for(seeded.entities, member_id)
      owner_row_id = member_row_for(seeded.entities, owner_id)

      conn = write_delete(owner_id, member_row_id)
      assert conn.status == 200
      assert Jason.decode!(conn.resp_body) == %{"rejected" => []}

      # A restart: the dirty marks are gone, the cache row is not, and the
      # keyset finds it before materialization applies the delete.
      DirtyTracker.reset()
      assert {:ok, stale} = SQLite.get_entity(member_row_id, SQLite)
      assert stale.deleted_hlc == nil

      {:ok, page} = GroupListing.list(group_id, owner_id)
      ids = Enum.map(page.entities, & &1.id)

      refute member_row_id in ids
      assert Enum.sort(ids) == Enum.sort([group_id, owner_row_id, eg_id, todo_id])
    end

    test "skips a member row whose log no longer places it in the group", %{tmp_dir: _} do
      owner_id = unique("a")
      group_id = unique("g")
      bootstrap(owner_id, group_id, ["todo.*", "ebb/grant.*"])
      [{todo_id, eg_id, _}] = write_todos(owner_id, group_id, 1)

      member_id = unique("a")
      assert add_member(owner_id, group_id, member_id, ["todo.read"]).status == 200

      {:ok, seeded} = GroupListing.list(group_id, owner_id)
      member_row_id = member_row_for(seeded.entities, member_id)
      owner_row_id = member_row_for(seeded.entities, owner_id)

      # The same row re-put with its grant component dropped: the cache still
      # files it under the group the keyset read, the log says it is not a
      # member of it.
      write_components(owner_id, [
        component_update(
          member_row_id,
          SystemComponent.component(:grant),
          "drop",
          nil
        )
      ])

      DirtyTracker.reset()

      {:ok, page} = GroupListing.list(group_id, owner_id)
      ids = Enum.map(page.entities, & &1.id)

      refute member_row_id in ids
      assert Enum.sort(ids) == Enum.sort([group_id, owner_row_id, eg_id, todo_id])
    end
  end

  describe "list/3 frontier and materialization" do
    test "reads the frontier before the page, so a mid-page write belongs to the tail", %{
      tmp_dir: _
    } do
      actor_id = unique("a")
      group_id = unique("g")
      bootstrap(actor_id, group_id)

      test_pid = self()
      late_entity_id = unique("todo")

      hook = fn ->
        frontier = WatermarkTracker.committed_watermark()
        send(test_pid, {:frontier, frontier})

        assert write_entity_with_membership(actor_id, late_entity_id, "todo", group_id, %{
                 "title" => %{"type" => "lww", "value" => "late", "hlc" => generate_hlc()}
               }).status == 200

        assert wait_until(fn -> WatermarkTracker.committed_watermark() > frontier end)
      end

      {:ok, page} = GroupListing.list(group_id, actor_id, after_watermark: hook)

      assert_receive {:frontier, frontier}
      assert page.watermark == frontier

      # The row is materialized after W, so it is both folded into the page
      # and re-delivered by the tail. Idempotent for the client.
      late = Enum.find(page.entities, &(&1.id == late_entity_id))
      assert late != nil
      assert late.last_gsn > page.watermark

      assert wait_until(fn ->
               case CatchUp.catch_up_group(group_id, actor_id, page.watermark) do
                 {:ok, actions, _meta} -> Enum.any?(actions, &(&1["gsn"] == late.last_gsn))
                 _ -> false
               end
             end)
    end

    test "materializes every row, so a row left stale by a restart comes back current", %{
      tmp_dir: _
    } do
      actor_id = unique("a")
      group_id = unique("g")
      bootstrap(actor_id, group_id)

      [{entity_id, _eg_id, _title}] = write_todos(actor_id, group_id, 1)

      {:ok, seeded_page} = GroupListing.list(group_id, actor_id)
      seeded = Enum.find(seeded_page.entities, &(&1.id == entity_id))
      assert title_of(seeded) == "title 1"

      assert write_patch(actor_id, entity_id, "patched").status == 200

      # A restart: the dirty marks are gone, the SQLite row is not.
      DirtyTracker.reset()

      assert {:ok, stale_row} = SQLite.get_entity(entity_id, EbbServer.Storage.SQLite)
      assert title_of(%{data: Jason.decode!(stale_row.data)}) == "title 1"

      {:ok, repaired_page} = GroupListing.list(group_id, actor_id)
      repaired = Enum.find(repaired_page.entities, &(&1.id == entity_id))

      assert title_of(repaired) == "patched"
      assert repaired.last_gsn > seeded.last_gsn
    end
  end

  defp unique(prefix), do: "#{prefix}_#{:erlang.unique_integer([:positive])}"

  defp bootstrap(actor_id, group_id, permissions \\ ["todo.*"]) do
    hlc = generate_hlc()
    gm_id = "gm_" <> Nanoid.generate()

    action = %{
      "id" => unique("act"),
      "actor_id" => actor_id,
      "hlc" => hlc,
      "updates" =>
        with_creates([
          component_update(
            group_id,
            SystemComponent.component(:group),
            "replace",
            leaf(%{"name" => "Test Group"}, hlc)
          ),
          component_update(
            gm_id,
            SystemComponent.component(:grant),
            "replace",
            leaf(
              %{"actor_id" => actor_id, "group_id" => group_id, "permissions" => permissions},
              hlc
            )
          )
        ])
    }

    conn = post_actions(msgpack_encode!(%{"actions" => [action]}), actor_id)
    assert conn.status == 200
    assert Jason.decode!(conn.resp_body) == %{"rejected" => []}
  end

  # One atomic `ebb/grant` row: the whole value is a single Update, so a grant
  # cannot tear. The row goes through the permission table, not the bootstrap
  # exemption, so `actor_id` must already hold `ebb/grant.create` there.
  defp add_member(actor_id, group_id, member_actor_id, permissions) do
    hlc = generate_hlc()

    action = %{
      "id" => unique("act"),
      "actor_id" => actor_id,
      "hlc" => hlc,
      "updates" =>
        with_creates([
          component_update(
            "gm_" <> Nanoid.generate(),
            SystemComponent.component(:grant),
            "replace",
            leaf(
              %{
                "actor_id" => member_actor_id,
                "group_id" => group_id,
                "permissions" => permissions
              },
              hlc
            )
          )
        ])
    }

    post_actions(msgpack_encode!(%{"actions" => [action]}), actor_id)
  end

  defp write_entity_with_membership(actor_id, entity_id, entity_model, group_id, fields) do
    hlc = generate_hlc()

    field_updates =
      Enum.map(fields, fn {field, value} ->
        %{
          "id" => unique("upd"),
          "subject_id" => entity_id,
          "component" => "#{entity_model}/#{field}",
          "method" => "replace",
          "data" => value
        }
      end)

    action = %{
      "id" => unique("act"),
      "actor_id" => actor_id,
      "hlc" => hlc,
      "updates" =>
        with_creates(
          field_updates ++ [membership_component_update(entity_id, group_id, hlc, nil)]
        )
    }

    post_actions(msgpack_encode!(%{"actions" => [action]}), actor_id)
  end

  defp membership_component_update(entity_id, group_id, hlc, eg_id) do
    eg_id = eg_id || derived_membership_id(entity_id, group_id)

    component_update(
      eg_id,
      SystemComponent.component(:membership),
      "replace",
      leaf(%{"entity_id" => entity_id, "group_id" => group_id}, hlc)
    )
  end

  defp derived_membership_id(entity_id, group_id), do: "eg_" <> entity_id <> "_" <> group_id

  # These tests corrupt one row of the read model so the listing's defence
  # against a cache that disagrees with the log runs. The row is patched
  # through the storage accessor the materializer writes it with, at the
  # row's own `last_gsn`, so the next read sees no unapplied action.
  defp patch_cached_row(id, attrs) do
    {:ok, row} = SQLite.get_entity(id, SQLite)

    meta = %{
      model: row.model,
      created_hlc: row.created_hlc,
      updated_hlc: row.updated_hlc,
      deleted_hlc: row.deleted_hlc,
      deleted_by: row.deleted_by,
      last_gsn: row.last_gsn
    }

    :ok = SQLite.patch_entity(id, %{}, [], Map.merge(meta, attrs), SQLite)
  end

  # Replaces a cached row's whole field map at the row's own `last_gsn`, so
  # the next read has nothing to replay over it. The shape is the shape the
  # materializer would have written: a row carries one component per field.
  defp patch_cached_data(id, title_field) do
    {:ok, row} = SQLite.get_entity(id, SQLite)
    components = ["todo/title"]

    :ok =
      SQLite.upsert_entity(
        %{
          id: id,
          model: "todo",
          data:
            Jason.encode!(%{"fields" => %{"title" => title_field}, "components" => components}),
          created_hlc: row.created_hlc,
          updated_hlc: row.updated_hlc,
          deleted_hlc: row.deleted_hlc,
          deleted_by: row.deleted_by,
          last_gsn: row.last_gsn,
          components: components
        },
        SQLite
      )
  end

  # An entity-actions entry with no Action behind it: materializing the id
  # fails the way a truncated log makes it fail.
  defp break_log(id) do
    {:ok, last_gsn} = SQLite.get_entity_last_gsn(id, SQLite)
    gsn = last_gsn + 1

    :ok =
      RocksDB.write_batch(
        [
          {:put, RocksDB.cf_entity_actions(RocksDB), RocksDB.encode_entity_flush_key(id, gsn),
           RocksDB.encode_gsn_list([gsn])}
        ],
        name: RocksDB
      )
  end

  defp get_listing(group_id, actor_id, params \\ %{}) do
    query = URI.encode_query(params)
    path = "/sync/groups/#{group_id}/entities"
    path = if query == "", do: path, else: path <> "?" <> query

    conn(:get, path)
    |> put_req_header("x-ebb-actor-id", actor_id)
    |> Router.call([])
  end

  defp write_todos(actor_id, group_id, count) do
    hlc = generate_hlc()

    entries =
      for i <- 1..count do
        {unique("todo"), unique("eg"), "title #{i}"}
      end

    updates =
      Enum.flat_map(entries, fn {entity_id, eg_id, title} ->
        [
          %{
            "id" => unique("upd"),
            "subject_id" => entity_id,
            "component" => "todo/title",
            "method" => "replace",
            "data" => %{"type" => "lww", "value" => title, "hlc" => hlc}
          }
        ] ++ [membership_component_update(entity_id, group_id, hlc, eg_id)]
      end)

    action = %{
      "id" => unique("act"),
      "actor_id" => actor_id,
      "hlc" => hlc,
      "updates" => with_creates(updates)
    }

    conn = post_actions(msgpack_encode!(%{"actions" => [action]}), actor_id)

    assert conn.status == 200
    assert Jason.decode!(conn.resp_body) == %{"rejected" => []}

    entries
  end

  defp collect_pages(group_id, actor_id, limit, cursor, acc) do
    {:ok, page} = GroupListing.list(group_id, actor_id, limit: limit, cursor: cursor)
    assert page.cursor == nil == (page.has_more == false)

    acc = acc ++ page.entities

    if page.has_more,
      do: collect_pages(group_id, actor_id, limit, page.cursor, acc),
      else: acc
  end

  defp write_action(actor_id, updates) do
    action = %{
      "id" => unique("act"),
      "actor_id" => actor_id,
      "hlc" => generate_hlc(),
      "updates" => with_creates(updates)
    }

    conn = post_actions(msgpack_encode!(%{"actions" => [action]}), actor_id)
    assert conn.status == 200
    assert Jason.decode!(conn.resp_body) == %{"rejected" => []}
  end

  defp link_update(source_id, field, type, target_id) do
    target = %{"value" => true, "hlc" => generate_hlc(), "update_id" => unique("upd_leaf")}

    component_update(
      source_id,
      SystemComponent.component(:link),
      "merge",
      %{"map" => %{field => %{"map" => %{type => %{"map" => %{target_id => target}}}}}}
    )
  end

  # Every target id a row's `ebb/link` field names, at any accessor and type.
  defp link_target_ids(row) do
    case fields_of(row)[SystemComponent.field(:link)] do
      %{"map" => by_accessor} ->
        for {_as, %{"map" => by_type}} <- by_accessor,
            {_type, %{"map" => by_target}} <- by_type,
            target_id <- Map.keys(by_target),
            do: target_id

      _absent ->
        []
    end
  end

  # A membership delete names no component: the server resolves the row's
  # entity and group from the membership index.
  defp membership_delete_update(eg_id) do
    %{"id" => unique("upd"), "subject_id" => eg_id, "method" => "delete", "data" => nil}
  end

  defp write_delete(actor_id, entity_id) do
    action = %{
      "id" => unique("act"),
      "actor_id" => actor_id,
      "hlc" => generate_hlc(),
      "updates" => [
        %{
          "id" => unique("upd"),
          "subject_id" => entity_id,
          "method" => "delete",
          "data" => nil
        }
      ]
    }

    post_actions(msgpack_encode!(%{"actions" => [action]}), actor_id)
  end

  defp component_update(subject_id, component, method, data) do
    %{
      "id" => unique("upd"),
      "subject_id" => subject_id,
      "component" => component,
      "method" => method,
      "data" => data
    }
  end

  defp write_components(actor_id, updates) do
    action = %{
      "id" => unique("act"),
      "actor_id" => actor_id,
      "hlc" => generate_hlc(),
      "updates" => with_creates(updates)
    }

    conn = post_actions(msgpack_encode!(%{"actions" => [action]}), actor_id)
    assert conn.status == 200
    assert Jason.decode!(conn.resp_body) == %{"rejected" => []}
  end

  defp leaf(value, hlc), do: %{"value" => value, "hlc" => hlc}

  defp write_patch(actor_id, entity_id, title) do
    action = %{
      "id" => unique("act"),
      "actor_id" => actor_id,
      "hlc" => generate_hlc(),
      "updates" => [
        %{
          "id" => unique("upd"),
          "subject_id" => entity_id,
          "component" => "todo/title",
          "method" => "merge",
          "data" => %{"type" => "lww", "value" => title, "hlc" => generate_hlc()}
        }
      ]
    }

    post_actions(msgpack_encode!(%{"actions" => [action]}), actor_id)
  end

  defp title_of(%{data: %{"fields" => %{"title" => %{"value" => title}}}}), do: title

  defp grant_id(entities) do
    [member] = Enum.filter(entities, &carries?(&1, :grant))
    member["id"]
  end

  defp member_row_for(entities, actor_id) do
    [row] =
      Enum.filter(
        entities,
        &(carries?(&1, :grant) and
            get_in(fields_of(&1), [SystemComponent.field(:grant), "value", "actor_id"]) ==
              actor_id)
      )

    row.id
  end

  # A row's fields, whether it is a wire view (string keys) or a listing row
  # (atom keys). Which component a row carries is the only way to tell the
  # platform kinds apart now that they share one model.
  defp fields_of(%{data: %{"fields" => fields}}), do: fields
  defp fields_of(%{"data" => %{"fields" => fields}}), do: fields
  defp fields_of(_row), do: %{}

  defp carries?(row, kind), do: Map.has_key?(fields_of(row), SystemComponent.field(kind))

  defp walk_pages(group_id, actor_id, limit, cursor \\ nil, acc \\ []) do
    {:ok, page} = GroupListing.list(group_id, actor_id, limit: limit, cursor: cursor)
    acc = acc ++ [page]

    if page.has_more,
      do: walk_pages(group_id, actor_id, limit, page.cursor, acc),
      else: acc
  end

  defp cursor_token(group_id, watermark, key) do
    %{"v" => 1, "group_id" => group_id, "w" => watermark, "key" => key}
    |> Jason.encode!()
    |> Base.url_encode64(padding: false)
  end

  defp cursor_key(token) do
    token
    |> Base.url_decode64!(padding: false)
    |> Jason.decode!()
    |> Map.fetch!("key")
  end

  defp last_membership_id(page) do
    page.entities
    |> Enum.filter(&carries?(&1, :membership))
    |> List.last()
    |> Map.fetch!(:id)
  end
end
