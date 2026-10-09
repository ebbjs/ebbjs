defmodule EbbServer.WritingActionsIntegrationTest do
  @moduledoc """
  Behavioral documentation for the action write pipeline.

  This module explains how actions flow through the system from HTTP request
  to persisted storage. Read this to understand the journey of an action.

  ## The Action Write Pipeline

  1. HTTP POST /sync/actions with MessagePack-encoded body
  2. AuthPlug extracts actor_id from x-ebb-actor-id header
  3. Router decodes MessagePack and passes to PermissionChecker
  4. PermissionChecker validates structure, HLC, then authorizes
  5. Writer assigns GSNs and writes to RocksDB
  6. DirtyTracker marks affected entities as dirty
  7. System caches (GroupCache, RelationshipCache) are updated

  ## Key Concepts

  * GSN (Global Sequence Number): Monotonically increasing integer assigned
    to each action, used for ordering and deduplication
  * HLC (Hybrid Logical Clock): 64-bit timestamp combining wall clock and
    logical time for causal ordering
  * Column Families: RocksDB organizes data into column families:
    - cf_actions: GSN → action mapping (primary store, includes Updates)
    - cf_entity_actions: (entity_id, GSN) → action_id (index for materialization)
    - cf_type_entities: (type, entity_id) → presence (type index)
    - cf_action_dedup: action_id → GSN (duplicate detection)
  * Dirty Tracking: Entities modified by writes are marked dirty and will
    be re-materialized on next read
  """

  use ExUnit.Case, async: false
  use EbbServer.Integration.StorageCase, with_auth_mode: true

  import Plug.Test
  import Plug.Conn
  import EbbServer.TestHelpers
  import EbbServer.Integration.ActionHelpers

  alias EbbServer.Storage.DirtyTracker
  alias EbbServer.Storage.RocksDB
  alias EbbServer.Sync.Router

  describe "Actions are validated before persisting" do
    setup do
      bootstrap_group("a_test", "g_test", ["todo.create", "todo.update", "todo.read"])
      :ok
    end

    test "valid action is accepted and persisted" do
      entity_id = "todo_valid_#{:erlang.unique_integer([:positive])}"
      hlc = generate_hlc()

      action_body = %{
        "id" => "act_valid_#{:erlang.unique_integer([:positive])}",
        "actor_id" => "a_test",
        "hlc" => hlc,
        "updates" => [
          %{
            "id" => "upd_valid_#{:erlang.unique_integer([:positive])}",
            "subject_id" => entity_id,
            "subject_type" => "todo",
            "method" => "put",
            "data" => %{
              "fields" => %{
                "title" => %{"type" => "lww", "value" => "Valid Action", "hlc" => hlc}
              }
            }
          },
          entity_group_update(entity_id, "g_test", hlc)
        ]
      }

      conn = post_actions(msgpack_encode!(%{"actions" => [action_body]}))

      assert conn.status == 200
      {:ok, response} = Jason.decode(conn.resp_body)
      assert response == %{"rejected" => []}
    end

    test "action with future HLC is rejected" do
      hlc_future = hlc_from(System.os_time(:millisecond) + 200_000)

      action_body = %{
        "id" => "act_future_#{:erlang.unique_integer([:positive])}",
        "actor_id" => "a_test",
        "hlc" => hlc_future,
        "updates" => [
          %{
            "id" => "upd_future_#{:erlang.unique_integer([:positive])}",
            "subject_id" => "todo_future",
            "subject_type" => "todo",
            "method" => "put",
            "data" => %{
              "fields" => %{
                "title" => %{"type" => "lww", "value" => "Future", "hlc" => hlc_future}
              }
            }
          }
        ]
      }

      conn = post_actions(msgpack_encode!(%{"actions" => [action_body]}))

      assert conn.status == 200
      {:ok, response} = Jason.decode(conn.resp_body)
      assert response["rejected"] != []
      assert hd(response["rejected"])["reason"] == "hlc_future_drift"
    end
  end

  describe "GSN assignment provides total ordering" do
    setup do
      bootstrap_group("a_test", "g_test", ["todo.create", "todo.read"])
      :ok
    end

    test "consecutive actions receive consecutive GSNs" do
      entity1 = "todo_seq1_#{:erlang.unique_integer([:positive])}"
      entity2 = "todo_seq2_#{:erlang.unique_integer([:positive])}"
      hlc1 = generate_hlc()
      hlc2 = generate_hlc()

      action1 = %{
        "id" => "act_seq1_#{:erlang.unique_integer([:positive])}",
        "actor_id" => "a_test",
        "hlc" => hlc1,
        "updates" => [
          %{
            "id" => "upd_seq1_#{:erlang.unique_integer([:positive])}",
            "subject_id" => entity1,
            "subject_type" => "todo",
            "method" => "put",
            "data" => %{
              "fields" => %{"title" => %{"type" => "lww", "value" => "First", "hlc" => hlc1}}
            }
          },
          entity_group_update(entity1, "g_test", hlc1)
        ]
      }

      action2 = %{
        "id" => "act_seq2_#{:erlang.unique_integer([:positive])}",
        "actor_id" => "a_test",
        "hlc" => hlc2,
        "updates" => [
          %{
            "id" => "upd_seq2_#{:erlang.unique_integer([:positive])}",
            "subject_id" => entity2,
            "subject_type" => "todo",
            "method" => "put",
            "data" => %{
              "fields" => %{"title" => %{"type" => "lww", "value" => "Second", "hlc" => hlc2}}
            }
          },
          entity_group_update(entity2, "g_test", hlc2)
        ]
      }

      post_actions(msgpack_encode!(%{"actions" => [action1]}))
      post_actions(msgpack_encode!(%{"actions" => [action2]}))

      conn1 =
        conn(:get, "/entities/#{entity1}")
        |> put_req_header("x-ebb-actor-id", "a_test")
        |> Router.call([])

      conn2 =
        conn(:get, "/entities/#{entity2}")
        |> put_req_header("x-ebb-actor-id", "a_test")
        |> Router.call([])

      {:ok, e1} = Jason.decode(conn1.resp_body)
      {:ok, e2} = Jason.decode(conn2.resp_body)

      assert e1["last_gsn"] == 2
      assert e2["last_gsn"] == 3
    end
  end

  describe "Re-submitting a committed Action is idempotent (#285)" do
    setup do
      bootstrap_group("a_test", "g_test", ["todo.create", "todo.read"])
      :ok
    end

    test "the same Action body is a silent no-op with single application" do
      entity_id = "todo_dedup_#{:erlang.unique_integer([:positive])}"
      hlc = generate_hlc()

      action_body = %{
        "id" => "act_dedup_#{:erlang.unique_integer([:positive])}",
        "actor_id" => "a_test",
        "hlc" => hlc,
        "updates" => [
          %{
            "id" => "upd_dedup_#{:erlang.unique_integer([:positive])}",
            "subject_id" => entity_id,
            "subject_type" => "todo",
            "method" => "put",
            "data" => %{
              "fields" => %{
                "title" => %{"type" => "lww", "value" => "Dedup", "hlc" => hlc}
              }
            }
          },
          entity_group_update(entity_id, "g_test", hlc)
        ]
      }

      body = msgpack_encode!(%{"actions" => [action_body]})

      conn = post_actions(body)
      assert conn.status == 200
      assert Jason.decode!(conn.resp_body) == %{"rejected" => []}

      max_gsn = RocksDB.get_max_gsn()
      first_entity = Jason.decode!(get_entity(entity_id).resp_body)

      resubmit = post_actions(body)
      assert resubmit.status == 200
      assert Jason.decode!(resubmit.resp_body) == %{"rejected" => []}

      assert RocksDB.get_max_gsn() == max_gsn
      second_entity = Jason.decode!(get_entity(entity_id).resp_body)
      assert second_entity["last_gsn"] == first_entity["last_gsn"]
    end
  end

  describe "Writing marks entities as dirty for later materialization" do
    setup do
      bootstrap_group("a_test", "g_test", ["todo.create", "todo.read"])
      :ok
    end

    test "entity is dirty immediately after write" do
      entity_id = "todo_dirty_#{:erlang.unique_integer([:positive])}"
      hlc = generate_hlc()

      action_body = %{
        "id" => "act_dirty_#{:erlang.unique_integer([:positive])}",
        "actor_id" => "a_test",
        "hlc" => hlc,
        "updates" => [
          %{
            "id" => "upd_dirty_#{:erlang.unique_integer([:positive])}",
            "subject_id" => entity_id,
            "subject_type" => "todo",
            "method" => "put",
            "data" => %{
              "fields" => %{"title" => %{"type" => "lww", "value" => "Dirty Test", "hlc" => hlc}}
            }
          },
          entity_group_update(entity_id, "g_test", hlc)
        ]
      }

      post_actions(msgpack_encode!(%{"actions" => [action_body]}))

      assert DirtyTracker.dirty?(entity_id)
    end
  end
end
