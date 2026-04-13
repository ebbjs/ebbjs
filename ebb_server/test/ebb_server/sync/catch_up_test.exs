defmodule EbbServer.Sync.CatchUpTest do
  use ExUnit.Case, async: false
  use EbbServer.Integration.StorageCase

  alias EbbServer.Sync.CatchUp
  alias EbbServer.Integration.ActionHelpers

  describe "catch_up_group/3" do
    test "happy path: returns actions sorted by GSN with up_to_date: true" do
      actor_id = "a_happy_#{:erlang.unique_integer([:positive])}"
      group_id = "g_happy_#{:erlang.unique_integer([:positive])}"

      ActionHelpers.bootstrap_group(actor_id, group_id, [
        "todo.read",
        "todo.write",
        "todo.create"
      ])

      entity_id = "todo_#{Nanoid.generate()}"

      ActionHelpers.write_entity_in_group(actor_id, entity_id, "todo", group_id, %{
        "title" => %{
          "type" => "lww",
          "value" => "First Task",
          "hlc" => "2024-01-01T00:00:00.000Z"
        }
      })

      Process.sleep(200)

      {:ok, _actions, meta} = CatchUp.catch_up_group(group_id, actor_id, 0)
      assert meta.up_to_date == true
      assert meta.next_offset == nil
    end

    test "offset filtering: returns only actions with GSN > offset" do
      a_id = "a_offset_#{:erlang.unique_integer([:positive])}"
      g_id = "g_offset_#{:erlang.unique_integer([:positive])}"

      ActionHelpers.bootstrap_group(a_id, g_id, [
        "todo.read",
        "todo.write",
        "todo.create"
      ])

      entity_id = "todo_#{Nanoid.generate()}"

      for i <- 1..3 do
        result =
          ActionHelpers.write_entity_in_group(a_id, entity_id, "todo", g_id, %{
            "title" => %{
              "type" => "lww",
              "value" => "Task #{i}",
              "hlc" => "2024-01-0#{i}T00:00:00.000Z"
            }
          })

        assert result.status == 200
      end

      Process.sleep(200)

      {:ok, actions, _meta} = CatchUp.catch_up_group(g_id, a_id, 2)
      assert length(actions) == 2
      assert Enum.all?(actions, fn a -> a["gsn"] > 2 end)
    end

    test "pagination detection: more than limit triggers next_offset" do
      actor_id = "a_page_#{:erlang.unique_integer([:positive])}"
      group_id = "g_page_#{:erlang.unique_integer([:positive])}"

      ActionHelpers.bootstrap_group(actor_id, group_id, [
        "todo.read",
        "todo.write",
        "todo.create"
      ])

      entity_id = "todo_#{Nanoid.generate()}"

      for i <- 1..250 do
        month = if i < 10, do: "0#{i}", else: Integer.to_string(i)

        result =
          ActionHelpers.write_entity_in_group(actor_id, entity_id, "todo", group_id, %{
            "title" => %{
              "type" => "lww",
              "value" => "Task #{i}",
              "hlc" => "2024-01-#{month}T00:00:00.000Z"
            }
          })

        assert result.status == 200
      end

      Process.sleep(300)

      # bootstrap (1) + 250 writes (2-251) = 251 actions total
      assert {:ok, first_page, meta} = CatchUp.catch_up_group(group_id, actor_id, 0, limit: 200)
      assert length(first_page) == 200
      assert meta.up_to_date == false
      assert is_integer(meta.next_offset)

      assert {:ok, second_page, final_meta} =
               CatchUp.catch_up_group(group_id, actor_id, meta.next_offset, limit: 200)

      # 251 total - 200 first = 51 second page
      assert length(second_page) == 51
      assert final_meta.up_to_date == true
      assert final_meta.next_offset == nil
    end

    test "non-member rejection: returns {:error, :not_member}" do
      group_id = "g_unknown_#{:erlang.unique_integer([:positive])}"
      non_member_actor = "a_outsider_#{:erlang.unique_integer([:positive])}"

      result = CatchUp.catch_up_group(group_id, non_member_actor, 0)

      assert result == {:error, :not_member}
    end
  end
end
