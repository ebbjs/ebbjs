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

  alias EbbServer.Storage.{DirtyTracker, SQLite, WatermarkTracker}
  alias EbbServer.Sync.{CatchUp, GroupListing, Router}

  @entity_keys ["created_hlc", "data", "deleted_hlc", "id", "last_gsn", "type", "updated_hlc"]

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

      # The row set is the group's state: the group row and its membership
      # rows carry no entityGroup row, so a membership join alone misses them.
      assert Enum.count(entities, &(&1["type"] == "group")) == 1
      assert group_id in ids

      assert Enum.count(entities, &(&1["type"] == "groupMember")) == 1

      assert Enum.count(entities, &(&1["type"] == "entityGroup")) == 2

      assert Enum.sort(ids) ==
               Enum.sort([group_id, group_member_id(entities), todo_a, todo_b, eg_a, eg_b])

      for entity <- entities do
        assert entity |> Map.keys() |> Enum.sort() == @entity_keys
      end

      # `GET /entities/:id` authorizes through membership rows, so it cannot
      # read the system rows themselves (a `group` or `groupMember` row has no
      # `entityGroup` row behind it). Every user entity it can read must be
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

        assert write_entity_in_group(actor_id, late_entity_id, "todo", group_id, %{
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

  defp bootstrap(actor_id, group_id) do
    conn = bootstrap_group(actor_id, group_id, ["todo.*"])
    assert conn.status == 200
    assert Jason.decode!(conn.resp_body) == %{"rejected" => []}
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
            "subject_type" => "todo",
            "method" => "put",
            "data" => %{
              "fields" => %{"title" => %{"type" => "lww", "value" => title, "hlc" => hlc}}
            }
          },
          %{
            "id" => eg_id,
            "subject_id" => eg_id,
            "subject_type" => "entityGroup",
            "method" => "put",
            "data" => %{
              "fields" => %{
                "entity_id" => %{"type" => "lww", "value" => entity_id, "hlc" => hlc},
                "group_id" => %{"type" => "lww", "value" => group_id, "hlc" => hlc}
              }
            }
          }
        ]
      end)

    action = %{"id" => unique("act"), "actor_id" => actor_id, "hlc" => hlc, "updates" => updates}
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

  defp write_delete(actor_id, entity_id) do
    action = %{
      "id" => unique("act"),
      "actor_id" => actor_id,
      "hlc" => generate_hlc(),
      "updates" => [
        %{
          "id" => unique("upd"),
          "subject_id" => entity_id,
          "subject_type" => "todo",
          "method" => "delete",
          "data" => nil
        }
      ]
    }

    post_actions(msgpack_encode!(%{"actions" => [action]}), actor_id)
  end

  defp write_patch(actor_id, entity_id, title) do
    action = %{
      "id" => unique("act"),
      "actor_id" => actor_id,
      "hlc" => generate_hlc(),
      "updates" => [
        %{
          "id" => unique("upd"),
          "subject_id" => entity_id,
          "subject_type" => "todo",
          "method" => "patch",
          "data" => %{
            "fields" => %{
              "title" => %{"type" => "lww", "value" => title, "hlc" => generate_hlc()}
            }
          }
        }
      ]
    }

    post_actions(msgpack_encode!(%{"actions" => [action]}), actor_id)
  end

  defp title_of(%{data: %{"fields" => %{"title" => %{"value" => title}}}}), do: title

  defp group_member_id(entities) do
    [member] = Enum.filter(entities, &(&1["type"] == "groupMember"))
    member["id"]
  end
end
