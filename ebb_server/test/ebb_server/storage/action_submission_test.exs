defmodule EbbServer.Storage.ActionSubmissionTest.StalledWriter do
  @moduledoc false

  # Accepts the write call and never replies, which is what the Writer looks
  # like to a caller that hits the default `GenServer.call/2` timeout.
  use GenServer

  def start_link(name), do: GenServer.start_link(__MODULE__, nil, name: name)

  @impl true
  def init(_opts), do: {:ok, nil}

  @impl true
  def handle_call({:write_actions, _actions, _sent_at}, _from, state), do: {:noreply, state}
end

defmodule EbbServer.Storage.ActionSubmissionTest do
  use ExUnit.Case, async: false

  import EbbServer.TestHelpers

  alias EbbServer.Storage.{ActionSubmission, EntityStore}

  setup do
    cache = start_isolated_cache()
    %{name: rocks_name, dir: dir} = start_rocks()
    %{name: sqlite_name} = start_sqlite(dir)
    %{name: writer_name} = start_writer(Map.put(cache, :rocks_name, rocks_name))

    %{
      cache: cache,
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      writer_name: writer_name
    }
  end

  describe "submit/3" do
    test "writes an authorized action and returns its GSN range", ctx do
      put_membership(ctx.cache, "todo_new", "g_1", "a_1")
      action = put_action("act_new", "a_1", "todo_new")

      assert {:ok, {gsn, gsn}, []} = ActionSubmission.submit([action], "a_1", opts(ctx))
      assert gsn == 1

      assert {:ok, entity} = EntityStore.get("todo_new", "a_1", store_opts(ctx))
      assert entity.data["fields"]["title"]["value"] == "Buy milk"
    end

    test "reports an unauthorized action as a rejection without writing it", ctx do
      put_membership(ctx.cache, "todo_owned", "g_1", "a_1")
      action = put_action("act_rejected", "a_2", "todo_owned")

      assert {:ok, {0, 0}, [rejection]} = ActionSubmission.submit([action], "a_2", opts(ctx))
      assert rejection["id"] == "act_rejected"
      assert rejection["reason"] == "not_authorized"
      assert :not_found = EntityStore.get("todo_owned", "a_2", store_opts(ctx))
    end

    test "reports a malformed action as a rejection", ctx do
      action = %{
        "id" => "act_malformed",
        "actor_id" => "a_1",
        "hlc" => generate_hlc(),
        "updates" => []
      }

      assert {:ok, {0, 0}, [rejection]} = ActionSubmission.submit([action], "a_1", opts(ctx))
      assert rejection["id"] == "act_malformed"
      assert is_binary(rejection["reason"])
    end

    test "reports an Action over 1 MiB without assigning a GSN or writing it", ctx do
      put_membership(ctx.cache, "todo_big", "g_1", "a_1")
      action = oversize_action("act_big", "todo_big", 1_100_000)
      assert :erlang.external_size(action) > 1_048_576

      assert {:ok, {0, 0}, [rejection]} = ActionSubmission.submit([action], "a_1", opts(ctx))
      assert rejection["id"] == "act_big"
      assert rejection["reason"] == "action_too_large"
      assert :not_found = EntityStore.get("todo_big", "a_1", store_opts(ctx))
    end

    test "reports an Action with more than 1000 Updates without writing it", ctx do
      put_membership(ctx.cache, "todo_many", "g_1", "a_1")
      action = many_updates_action("act_many", "todo_many", 1_001)

      assert {:ok, {0, 0}, [rejection]} = ActionSubmission.submit([action], "a_1", opts(ctx))
      assert rejection["id"] == "act_many"
      assert rejection["reason"] == "too_many_updates"
      assert :not_found = EntityStore.get("todo_many", "a_1", store_opts(ctx))
    end

    test "a mixed batch writes the in-cap Action and rejects the over-cap one", ctx do
      put_membership(ctx.cache, "todo_ok", "g_1", "a_1")
      put_membership(ctx.cache, "todo_big", "g_1", "a_1")

      valid = put_action("act_ok", "a_1", "todo_ok")
      oversize = oversize_action("act_big", "todo_big", 1_100_000)

      assert {:ok, {1, 1}, [rejection]} =
               ActionSubmission.submit([valid, oversize], "a_1", opts(ctx))

      assert {rejection["id"], rejection["reason"]} == {"act_big", "action_too_large"}
      assert {:ok, _entity} = EntityStore.get("todo_ok", "a_1", store_opts(ctx))
      assert :not_found = EntityStore.get("todo_big", "a_1", store_opts(ctx))
    end

    test "maps a Writer call exit to an error instead of crashing the caller", ctx do
      put_membership(ctx.cache, "todo_exit", "g_1", "a_1")
      action = put_action("act_exit", "a_1", "todo_exit")

      opts = Keyword.put(opts(ctx), :writer_name, :ebb_missing_writer)

      assert {:error, {:write_exit, _reason}} = ActionSubmission.submit([action], "a_1", opts)
    end

    test "maps the GenServer.call timeout to an error with an unknown outcome", ctx do
      put_membership(ctx.cache, "todo_timeout", "g_1", "a_1")
      action = put_action("act_timeout", "a_1", "todo_timeout")

      name = :"stalled_writer_#{System.unique_integer([:positive])}"
      {:ok, pid} = EbbServer.Storage.ActionSubmissionTest.StalledWriter.start_link(name)
      on_exit(fn -> safe_stop(pid) end)

      opts = Keyword.put(opts(ctx), :writer_name, name)

      assert {:error, {:write_exit, {:timeout, {GenServer, :call, [^name, _msg, 5_000]}}}} =
               ActionSubmission.submit([action], "a_1", opts)
    end

    test "{0, 0} reports no GSN for a duplicate, not durability", ctx do
      put_membership(ctx.cache, "todo_dup", "g_1", "a_1")
      action = put_action("act_dup", "a_1", "todo_dup")

      assert {:ok, {1, 1}, []} = ActionSubmission.submit([action], "a_1", opts(ctx))
      assert {:ok, {0, 0}, []} = ActionSubmission.submit([action], "a_1", opts(ctx))
    end
  end

  defp put_action(id, actor_id, entity_id) do
    hlc = generate_hlc()

    %{
      "id" => id,
      "actor_id" => actor_id,
      "hlc" => hlc,
      "updates" => [
        %{
          "id" => "upd_" <> id,
          "subject_id" => entity_id,
          "subject_type" => "todo",
          "method" => "put",
          "data" => %{
            "fields" => %{"title" => %{"type" => "lww", "value" => "Buy milk", "hlc" => hlc}}
          }
        }
      ]
    }
  end

  defp oversize_action(id, entity_id, payload_bytes) do
    action = put_action(id, "a_1", entity_id)
    [update] = action["updates"]

    %{
      action
      | "updates" => [
          %{
            update
            | "data" => %{
                "fields" => %{
                  "title" => %{
                    "type" => "lww",
                    "value" => String.duplicate("x", payload_bytes),
                    "hlc" => update["data"]["fields"]["title"]["hlc"]
                  }
                }
              }
          }
        ]
    }
  end

  defp many_updates_action(id, entity_id, count) do
    action = put_action(id, "a_1", entity_id)
    template = hd(action["updates"])

    %{
      action
      | "updates" => Enum.map(1..count, fn index -> %{template | "id" => "upd_#{index}"} end)
    }
  end

  defp put_membership(cache, entity_id, group_id, actor_id) do
    :ets.insert(
      cache.entity_groups,
      {entity_id, %{id: "eg_1", entity_id: entity_id, group_id: group_id}}
    )

    :ets.insert(cache.entity_types, {entity_id, "todo"})

    :ets.insert(
      cache.group_members,
      {actor_id, %{id: "gm_1", group_id: group_id, permissions: ["todo.*"]}}
    )
  end

  defp opts(ctx) do
    [
      writer_name: ctx.writer_name,
      group_members: ctx.cache.group_members,
      group_members_by_id: ctx.cache.group_members_by_id,
      group_members_by_group: ctx.cache.group_members_by_group,
      entity_groups: ctx.cache.entity_groups,
      entity_groups_by_id: ctx.cache.entity_groups_by_id,
      entity_types: ctx.cache.entity_types,
      relationships_by_id: ctx.cache.relationships_by_id
    ]
  end

  defp store_opts(ctx) do
    [rocks_name: ctx.rocks_name, sqlite_name: ctx.sqlite_name, dirty_set: ctx.cache.dirty_set]
  end
end
