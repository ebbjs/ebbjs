defmodule EbbServer.Sync.CatchUpTest do
  use ExUnit.Case, async: false
  use EbbServer.Integration.StorageCase

  import EbbServer.TestHelpers

  alias EbbServer.Integration.ActionHelpers
  alias EbbServer.Storage.{ActionFormat, RocksDB, WatermarkTracker}
  alias EbbServer.Sync.CatchUp

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

    test "delivers an Action with no per-Update scopes whole (pre-#473 fallback)" do
      actor_id = "a_legacy_#{:erlang.unique_integer([:positive])}"
      group_id = "g_legacy_#{:erlang.unique_integer([:positive])}"

      ActionHelpers.bootstrap_group(actor_id, group_id, ["todo.read", "todo.create"])
      Process.sleep(100)

      gsn = RocksDB.get_max_gsn() + 1
      hlc = generate_hlc()

      # An Action committed before #473 has no `"update_scopes"`: catch-up
      # must return it whole rather than dropping it.
      legacy = %{
        "id" => "act_legacy_#{:erlang.unique_integer([:positive])}",
        "actor_id" => actor_id,
        "hlc" => hlc,
        "gsn" => gsn,
        "updates" => [
          %{
            "id" => "upd_legacy_#{:erlang.unique_integer([:positive])}",
            "subject_id" => "todo_legacy",
            "subject_type" => "todo",
            "method" => "put",
            "data" => %{
              "fields" => %{"title" => %{"type" => "lww", "value" => "x", "hlc" => hlc}}
            }
          }
        ]
      }

      :ok =
        RocksDB.write_batch([
          {:put, RocksDB.cf_actions(), RocksDB.encode_gsn_key(gsn),
           :erlang.term_to_binary(legacy)},
          {:put, RocksDB.cf_group_actions(), RocksDB.encode_group_action_key(group_id, gsn),
           legacy["id"]}
        ])

      :ok = WatermarkTracker.mark_range_committed(gsn, gsn)
      WatermarkTracker.advance_watermark()

      {:ok, actions, _meta} = CatchUp.catch_up_group(group_id, actor_id, gsn - 1)

      assert [returned] = actions
      assert returned["id"] == legacy["id"]
      assert length(returned["updates"]) == 1
    end

    test "delivers an Action stored in the new GSN-free wrapper shape" do
      actor_id = "a_wrapper_#{:erlang.unique_integer([:positive])}"
      group_id = "g_wrapper_#{:erlang.unique_integer([:positive])}"

      ActionHelpers.bootstrap_group(actor_id, group_id, ["todo.read", "todo.create"])
      Process.sleep(100)

      gsn = RocksDB.get_max_gsn() + 1
      hlc = generate_hlc()
      action_id = "act_wrapper_#{:erlang.unique_integer([:positive])}"
      update_id = "upd_wrapper_#{:erlang.unique_integer([:positive])}"

      payload =
        %{
          id: action_id,
          actor_id: actor_id,
          hlc: hlc,
          updates: [
            %{
              id: update_id,
              subject_id: "todo_wrapper",
              subject_type: "todo",
              method: :put,
              data: %{
                "fields" => %{"title" => %{"type" => "lww", "value" => "x", "hlc" => hlc}}
              }
            },
            %{
              id: "upd_other_#{:erlang.unique_integer([:positive])}",
              subject_id: "todo_other",
              subject_type: "todo",
              method: :put,
              data: %{}
            }
          ]
        }
        |> ActionFormat.build()
        |> ActionFormat.encode()

      # The second Update scopes to another group, so catch-up must use the
      # wrapper's scopes and drop it.
      wrapper = ActionFormat.wrap(payload, [[group_id], ["g_other"]])

      :ok =
        RocksDB.write_batch([
          {:put, RocksDB.cf_actions(), RocksDB.encode_gsn_key(gsn), wrapper},
          {:put, RocksDB.cf_group_actions(), RocksDB.encode_group_action_key(group_id, gsn),
           action_id}
        ])

      :ok = WatermarkTracker.mark_range_committed(gsn, gsn)
      WatermarkTracker.advance_watermark()

      {:ok, actions, _meta} = CatchUp.catch_up_group(group_id, actor_id, gsn - 1)

      assert [returned] = actions
      assert returned["gsn"] == gsn
      assert returned["id"] == action_id
      assert [%{"id" => ^update_id}] = returned["updates"]
    end

    test "non-member rejection: returns {:error, :not_member}" do
      group_id = "g_unknown_#{:erlang.unique_integer([:positive])}"
      non_member_actor = "a_outsider_#{:erlang.unique_integer([:positive])}"

      result = CatchUp.catch_up_group(group_id, non_member_actor, 0)

      assert result == {:error, :not_member}
    end
  end

  describe "catch_up_group/4 telemetry" do
    test "emits ebb.sync.catch_up for a full resync from offset 0" do
      actor_id = "a_tel_full_#{:erlang.unique_integer([:positive])}"
      group_id = "g_tel_full_#{:erlang.unique_integer([:positive])}"

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

      ref = attach_telemetry([[:ebb, :sync, :catch_up]])
      {:ok, actions, meta} = CatchUp.catch_up_group(group_id, actor_id, 0)

      assert [
               {[:ebb, :sync, :catch_up], %{count: 1},
                %{
                  group_id: ^group_id,
                  from_offset: 0,
                  returned: returned,
                  up_to_date: true
                }}
             ] = telemetry_events(ref)

      assert returned == length(actions)
      assert meta.up_to_date == true
    end

    test "tags an incremental catch-up with a non-zero from_offset" do
      actor_id = "a_tel_inc_#{:erlang.unique_integer([:positive])}"
      group_id = "g_tel_inc_#{:erlang.unique_integer([:positive])}"

      ActionHelpers.bootstrap_group(actor_id, group_id, [
        "todo.read",
        "todo.write",
        "todo.create"
      ])

      entity_id = "todo_#{Nanoid.generate()}"

      for i <- 1..3 do
        ActionHelpers.write_entity_in_group(actor_id, entity_id, "todo", group_id, %{
          "title" => %{
            "type" => "lww",
            "value" => "Task #{i}",
            "hlc" => "2024-01-0#{i}T00:00:00.000Z"
          }
        })
      end

      Process.sleep(200)

      ref = attach_telemetry([[:ebb, :sync, :catch_up]])
      {:ok, actions, _meta} = CatchUp.catch_up_group(group_id, actor_id, 2)

      assert [
               {[:ebb, :sync, :catch_up], %{count: 1},
                %{group_id: ^group_id, from_offset: 2, returned: returned}}
             ] = telemetry_events(ref)

      assert returned == length(actions)
    end

    test "emits nothing when the actor is not a member" do
      group_id = "g_tel_denied_#{:erlang.unique_integer([:positive])}"
      non_member_actor = "a_tel_denied_#{:erlang.unique_integer([:positive])}"

      ref = attach_telemetry([[:ebb, :sync, :catch_up]])

      assert {:error, :not_member} = CatchUp.catch_up_group(group_id, non_member_actor, 0)
      assert telemetry_events(ref) == []
    end
  end
end
