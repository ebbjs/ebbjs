defmodule EbbServer.PermissionQueryIntegrationTest do
  use ExUnit.Case, async: false
  use EbbServer.Integration.StorageCase

  import EbbServer.TestHelpers
  import EbbServer.Integration.ActionHelpers
  import EbbServer.Integration.QueryHelpers

  describe "permission-scoped query" do
    setup do
      bootstrap_group("actor_1", "group_1", ["todo.create", "todo.read"])
      bootstrap_group("actor_2", "group_2", ["todo.create", "todo.read"])
      :ok
    end

    test "permission-scoped query returns only visible entities" do
      hlc_1 = generate_hlc()
      hlc_2 = generate_hlc()

      action_1 = %{
        "id" => "act_q1_" <> Nanoid.generate(),
        "actor_id" => "actor_1",
        "hlc" => hlc_1,
        "updates" => [
          %{
            "id" => "upd_q1_" <> Nanoid.generate(),
            "subject_id" => "todo_1",
            "subject_type" => "todo",
            "method" => "put",
            "data" => %{
              "fields" => %{
                "title" => %{"type" => "lww", "value" => "Todo 1", "hlc" => hlc_1}
              }
            }
          },
          %{
            "id" => "rel_q1_" <> Nanoid.generate(),
            "subject_id" => "rel_q1_" <> Nanoid.generate(),
            "subject_type" => "relationship",
            "method" => "put",
            "data" => %{
              "source_id" => "todo_1",
              "target_id" => "group_1",
              "type" => "todo",
              "field" => "group"
            }
          }
        ]
      }

      action_2 = %{
        "id" => "act_q2_" <> Nanoid.generate(),
        "actor_id" => "actor_2",
        "hlc" => hlc_2,
        "updates" => [
          %{
            "id" => "upd_q2_" <> Nanoid.generate(),
            "subject_id" => "todo_2",
            "subject_type" => "todo",
            "method" => "put",
            "data" => %{
              "fields" => %{
                "title" => %{"type" => "lww", "value" => "Todo 2", "hlc" => hlc_2}
              }
            }
          },
          %{
            "id" => "rel_q2_" <> Nanoid.generate(),
            "subject_id" => "rel_q2_" <> Nanoid.generate(),
            "subject_type" => "relationship",
            "method" => "put",
            "data" => %{
              "source_id" => "todo_2",
              "target_id" => "group_2",
              "type" => "todo",
              "field" => "group"
            }
          }
        ]
      }

      post_actions(msgpack_encode!(%{"actions" => [action_1]}), "actor_1")
      post_actions(msgpack_encode!(%{"actions" => [action_2]}), "actor_2")

      conn = post_query(%{"type" => "todo"}, "actor_1")
      assert conn.status == 200

      {:ok, response} = Jason.decode(conn.resp_body)
      entity_ids = Enum.map(response, & &1["id"])
      assert "todo_1" in entity_ids
      refute "todo_2" in entity_ids

      conn = post_query(%{"type" => "todo"}, "actor_2")
      assert conn.status == 200

      {:ok, response} = Jason.decode(conn.resp_body)
      entity_ids = Enum.map(response, & &1["id"])
      assert "todo_2" in entity_ids
      refute "todo_1" in entity_ids
    end
  end
end
