defmodule EbbServer.Functions.WriteBunIntegrationTest do
  @moduledoc """
  The M2 acceptance path for `ctx.*` writes through a real Bun process.

  Every test here deploys a committed TypeScript fixture
  (`packages/functions-runtime/fixtures/write-bun/`) bundled with the esbuild
  configuration `@ebbjs/cli` uses, so the runtime resolves the write verbs
  against a real application schema inlined into the bundle. From there the
  path is the one a deployment runs: the boot-time flag, `AuthPlug`, the
  bundle cache and digest check, the invocation loop, `Functions.Host`, the
  shared `ActionSubmission` seam, storage, and fan-out to a live subscriber.

  The fake-runner acceptance tests cover the same claims with a scripted
  transport; these prove the claims survive the real runtime.

  Requires the workspace packages built (`pnpm build`): the runner resolves
  `@ebbjs/core`, `@ebbjs/schema`, and `@ebbjs/write` through their `dist`
  entries, and so does the bundle's schema import.
  """

  use ExUnit.Case, async: false
  use EbbServer.Integration.StorageCase, with_auth_mode: true

  import EbbServer.FunctionsTestHelpers
  import EbbServer.Integration.ActionHelpers, except: [get_entity: 1, get_entity: 2]
  import EbbServer.LiveStreamHelpers, only: [start_live_stream: 2]
  import EbbServer.SSEHelpers, only: [data_payloads: 1]
  import EbbServer.TestHelpers, only: [generate_hlc: 0]

  alias EbbServer.Storage.{ActionLog, WatermarkTracker}
  alias EbbServer.TestFunctions.Bundles

  alias EbbServer.TestFunctions.Bun, as: BunSupport

  @enabled_env "EBB_FUNCTIONS_ENABLED"
  @await_timeout_ms 10_000

  @moduletag :bun

  @moduletag skip:
               if(BunSupport.write_fixtures_available?(),
                 do: false,
                 else:
                   "Bun, esbuild, the built workspace packages, or the write fixtures are missing"
               )

  setup do
    previous_env = System.get_env(@enabled_env)
    System.delete_env(@enabled_env)

    on_exit(fn ->
      if previous_env, do: System.put_env(@enabled_env, previous_env)
    end)

    dir = Bundles.tmp_bundle_dir()
    cache = start_cache(dir)

    %{dir: dir, cache: cache}
  end

  test "a create is visible to the handler before commit and to a subscriber after", %{dir: dir} do
    name = "createAndRead"
    actor_id = unique("a")
    group_id = unique("g")
    title = "written by the function"

    seed_member(actor_id, group_id, ["function." <> name, "todo.create", "todo.read"])

    BunSupport.deploy_fixture!(dir, name)
    configure_bun(dir)

    stream = start_live_stream(group_id, actor_id)
    before = WatermarkTracker.committed_watermark()

    response = post_function(name, params_with_title(group_id, title), actor_id)

    assert response.status == 200
    body = Jason.decode!(response.resp_body)
    assert body["ok"] == true
    assert body["replayed"] == false
    assert body["version"] == "1.0.0"

    created_id = body["result"]["id"]
    overlay = body["result"]["overlay"]
    assert overlay["id"] == created_id
    assert overlay["model"] == "todo"
    assert overlay["deleted_hlc"] == nil
    # A row this invocation created has no GSN yet, and the overlay carries
    # the write's own HLCs rather than the stored row's.
    assert overlay["last_gsn"] == 0
    # The overlay carries the row's creation time; that it is the create's own
    # stamp is asserted where the row is committed (`entity_store_test.exs`,
    # `row_create_integration_test.exs`).
    assert is_binary(overlay["created_hlc"])
    # The overlay publishes the same wire shape the endpoint does: a field is
    # its leaf, not a projected value.
    assert overlay["data"]["fields"]["title"]["value"] == title
    assert is_binary(overlay["data"]["fields"]["title"]["hlc"])

    # The same write is durable and readable through the ordinary endpoint.
    read = get_entity(created_id, actor_id)
    assert read.status == 200
    entity = Jason.decode!(read.resp_body)
    assert entity["id"] == created_id
    assert entity["model"] == "todo"
    assert entity["data"]["fields"]["title"]["value"] == title

    assert WatermarkTracker.committed_watermark() == before + 1
    assert [_action] = ActionLog.read(before + 1, before + 1)

    # Subscribed before the invocation, so this is live fan-out rather than a
    # catch-up replay the assertion could pass without fan-out working.
    assert_receive {:chunk_written, bytes}, @await_timeout_ms
    assert [payload] = data_payloads(bytes)
    event = Jason.decode!(payload)
    assert event["id"] == action_id_for(body["invocation_id"])
    assert event["gsn"] == before + 1

    assert Enum.any?(
             event["updates"],
             &(&1["subject_id"] == created_id and &1["component"] == "todo/title" and
                 &1["method"] == "replace")
           )

    Task.shutdown(stream, :brutal_kill)
  end

  test "many buffered writes leave as one Action with one GSN", %{dir: dir} do
    name = "createTwoAndPatch"
    actor_id = unique("a")
    group_id = unique("g")

    seed_member(actor_id, group_id, [
      "function." <> name,
      "todo.create",
      "todo.update",
      "project.create",
      "ebb/link.*"
    ])

    BunSupport.deploy_fixture!(dir, name)
    configure_bun(dir)

    before = WatermarkTracker.committed_watermark()

    response = post_function(name, params(group_id), actor_id)

    assert response.status == 200
    body = Jason.decode!(response.resp_body)
    assert [todo_id, project_id] = body["result"]["ids"]

    # One commit frame: one Action, one GSN, however many verbs were buffered.
    assert WatermarkTracker.committed_watermark() == before + 1
    assert [action] = ActionLog.read(before + 1, before + 1)
    assert action["id"] == action_id_for(body["invocation_id"])
    assert action["gsn"] == before + 1

    updates = action["updates"]
    subject_ids = MapSet.new(updates, & &1["subject_id"])
    assert MapSet.subset?(MapSet.new(body["result"]["ids"]), subject_ids)

    # Two creates (each entity plus its `ebb/membership` row), one patch, one
    # one-cardinality link. A platform row is one atomic component, so each is
    # one Update rather than one per field.
    membership_updates = Enum.filter(updates, &(&1["component"] == "ebb/membership"))

    assert length(membership_updates) == 2

    [patch] = Enum.filter(updates, &(&1["component"] == "todo/done"))
    assert patch["subject_id"] == todo_id
    assert patch["data"]["value"] == true

    # The edge is a keyed component of the todo the same Action created:
    # `project` → `todo` (the source model is the default `type`) → the
    # target, with presence as the leaf.
    assert [link] = Enum.filter(updates, &(&1["component"] == "ebb/link"))
    assert link["method"] == "merge"
    assert link["subject_id"] == todo_id
    assert [{"project", "todo", ^project_id, %{"value" => true}}] = link_edges(link["data"])
  end

  test "a handler that throws after a create leaves nothing", %{dir: dir} do
    name = "createThenThrow"
    actor_id = unique("a")
    group_id = unique("g")
    doomed_id = unique("todo_fn")

    seed_member(actor_id, group_id, ["function." <> name, "todo.create", "todo.read"])

    BunSupport.deploy_fixture!(dir, name)
    configure_bun(dir)

    before = WatermarkTracker.committed_watermark()

    response =
      post_function(name, Jason.encode!(%{"group_id" => group_id, "id" => doomed_id}), actor_id)

    assert response.status == 422
    body = Jason.decode!(response.resp_body)
    assert body["error"] == "handler_error"
    assert body["details"] == "boom after create"

    # The buffered create never reached the server, with or without a commit.
    assert get_entity(doomed_id, actor_id).status == 404
    assert WatermarkTracker.committed_watermark() == before
    assert ActionLog.read(before + 1, before + 10) == []
  end

  test "a rejected write reports what POST /sync/actions reports", %{dir: dir} do
    name = "patchForeign"
    actor_id = unique("a")
    group_id = unique("g")
    owner_id = unique("a")
    other_group = unique("g")
    foreign_id = unique("todo_other")

    seed_member(actor_id, group_id, ["function." <> name])

    seed_member(owner_id, other_group, [
      "todo.create",
      "todo.update",
      "todo.read"
    ])

    assert write_entity_in_group(owner_id, foreign_id, "todo", other_group, fields("not yours")).status ==
             200

    BunSupport.deploy_fixture!(dir, name)
    configure_bun(dir)

    before = WatermarkTracker.committed_watermark()

    response = post_function(name, Jason.encode!(%{"todo_id" => foreign_id}), actor_id)

    assert response.status == 422
    body = Jason.decode!(response.resp_body)
    assert body["error"] == "rejected"
    assert [rejection] = body["rejected"]
    assert rejection["reason"] == "not_authorized"
    assert rejection["id"] == action_id_for(body["invocation_id"])

    # The same Action through the client endpoint is rejected the same way:
    # both paths run `ActionSubmission.submit/3`, so the `rejected[]` list is
    # the same list, not merely the same reason.
    sync_response =
      post_actions(
        msgpack_encode!(%{
          "actions" => [foreign_patch(action_id_for(body["invocation_id"]), actor_id, foreign_id)]
        }),
        actor_id
      )

    assert sync_response.status == 200
    assert Jason.decode!(sync_response.resp_body)["rejected"] == body["rejected"]

    # Nothing was written.
    read = get_entity(foreign_id, owner_id)
    assert read.status == 200
    assert Jason.decode!(read.resp_body)["data"]["fields"]["title"]["value"] == "not yours"
    assert WatermarkTracker.committed_watermark() == before
  end

  test "a retry with the same Idempotency-Key replays and drops the new write", %{dir: dir} do
    name = "createWithTitle"
    actor_id = unique("a")
    group_id = unique("g")
    key = unique("idem")

    seed_member(actor_id, group_id, ["function." <> name, "todo.create", "todo.read"])

    BunSupport.deploy_fixture!(dir, name)
    configure_bun(dir)

    before = WatermarkTracker.committed_watermark()

    first =
      post_function(name, params_with_title(group_id, "first"), actor_id, [
        {"idempotency-key", key}
      ])

    assert first.status == 200
    first_body = Jason.decode!(first.resp_body)
    assert first_body["replayed"] == false
    first_id = first_body["result"]["id"]

    # Same key, a handler that produces different writes: the server owns the
    # action id, so the second submission is dropped as a replay.
    second =
      post_function(name, params_with_title(group_id, "second"), actor_id, [
        {"idempotency-key", key}
      ])

    assert second.status == 200
    second_body = Jason.decode!(second.resp_body)
    assert second_body["replayed"] == true
    assert second_body["invocation_id"] == first_body["invocation_id"]

    assert action_id_for(second_body["invocation_id"]) ==
             action_id_for(first_body["invocation_id"])

    second_id = second_body["result"]["id"]
    refute second_id == first_id

    # Exactly one Action and one GSN: the retry added nothing.
    assert WatermarkTracker.committed_watermark() == before + 1
    assert [_only] = ActionLog.read(before + 1, before + 1)

    first_read = get_entity(first_id, actor_id)
    assert first_read.status == 200
    assert Jason.decode!(first_read.resp_body)["data"]["fields"]["title"]["value"] == "first"
    assert get_entity(second_id, actor_id).status == 404
  end

  test "a one-cardinality link and unlink within one invocation leave one Action", %{dir: dir} do
    name = "linkThenUnlink"
    actor_id = unique("a")
    group_id = unique("g")
    project_id = unique("project")

    seed_member(actor_id, group_id, [
      "function." <> name,
      "todo.create",
      "todo.update",
      "project.create",
      "ebb/link.*"
    ])

    assert write_entity_in_group(actor_id, project_id, "project", group_id, fields("a project")).status ==
             200

    BunSupport.deploy_fixture!(dir, name)
    configure_bun(dir)

    stream = start_live_stream(group_id, actor_id)
    before = WatermarkTracker.committed_watermark()

    response = post_function(name, params_with_project(group_id, project_id), actor_id)

    assert response.status == 200
    body = Jason.decode!(response.resp_body)
    created_id = body["result"]["id"]

    assert WatermarkTracker.committed_watermark() == before + 1
    assert [action] = ActionLog.read(before + 1, before + 1)
    assert action["gsn"] == before + 1

    # The edge is a keyed component of its source, so both writes name the
    # row the function created and only the leaf carries the edge: presence
    # for the link, the tombstone for the unlink it reversed.
    link_updates = Enum.filter(action["updates"], &(&1["component"] == "ebb/link"))

    assert length(link_updates) == 2
    assert Enum.all?(link_updates, &(&1["subject_id"] == created_id))
    assert Enum.all?(link_updates, &(&1["method"] == "merge"))

    leaves =
      for update <- link_updates,
          {field, _type, _target, leaf} <- link_edges(update["data"]),
          do: {field, leaf["value"]}

    assert Enum.sort(leaves) == [{"project", nil}, {"project", true}]

    # And both were scoped to the source's group, so a live subscriber
    # receives them rather than a link that silently survives delivery.
    assert_receive {:chunk_written, bytes}, @await_timeout_ms
    assert [payload] = data_payloads(bytes)
    event = Jason.decode!(payload)
    assert event["gsn"] == before + 1

    assert Enum.count(
             Enum.filter(event["updates"], &(&1["component"] == "ebb/link")),
             &(&1["subject_id"] == created_id)
           ) == 2

    Task.shutdown(stream, :brutal_kill)
  end

  # Two edges stored on the todo the function will unlink one of.
  defp seed_edges(actor_id, todo_id, target_ids) do
    hlc = generate_hlc()

    leaves =
      Map.new(target_ids, fn target_id ->
        {target_id, %{"value" => true, "update_id" => unique("u_seed_edge"), "hlc" => hlc}}
      end)

    action = %{
      "id" => unique("act_seed_edges"),
      "actor_id" => actor_id,
      "hlc" => hlc,
      "updates" => [
        component_update(
          unique("upd_seed_edges"),
          todo_id,
          "ebb/link",
          "merge",
          %{"map" => %{"labels" => %{"map" => %{"todo" => %{"map" => leaves}}}}}
        )
      ]
    }

    post_actions(msgpack_encode!(%{"actions" => [action]}), actor_id)
  end

  # An edge's key levels: field, then type, then target id, then its leaf.
  defp link_edges(%{"map" => fields}) do
    for {field, %{"map" => types}} <- fields,
        {type, %{"map" => targets}} <- types,
        {target, leaf} <- targets do
      {field, type, target, leaf}
    end
  end

  test "a patch of a stored row reads back in the wire shape", %{dir: dir} do
    name = "patchStoredTodo"
    actor_id = unique("a")
    group_id = unique("g")
    todo_id = unique("todo")

    seed_member(actor_id, group_id, [
      "function." <> name,
      "todo.create",
      "todo.update",
      "todo.read"
    ])

    hlc = generate_hlc()

    stored_fields = %{
      "title" => %{"type" => "lww", "value" => "stored", "hlc" => hlc},
      "done" => %{"type" => "lww", "value" => false, "hlc" => hlc}
    }

    assert write_entity_in_group(actor_id, todo_id, "todo", group_id, stored_fields).status == 200

    BunSupport.deploy_fixture!(dir, name)
    configure_bun(dir)

    response =
      post_function(
        name,
        Jason.encode!(%{"todo_id" => todo_id, "title" => "patched"}),
        actor_id
      )

    assert response.status == 200
    view = Jason.decode!(response.resp_body)["result"]["view"]

    # The patched field is the buffered write's wire leaf and the untouched
    # sibling keeps the stored one, so a read does not change shape because the
    # invocation wrote to the row.
    assert view["data"]["fields"]["title"]["value"] == "patched"
    assert is_binary(view["data"]["fields"]["title"]["hlc"])
    assert view["data"]["fields"]["done"]["value"] == false

    read = get_entity(todo_id, actor_id)
    assert read.status == 200
    read_body = Jason.decode!(read.resp_body)
    assert read_body["data"]["fields"]["title"]["value"] == "patched"
    # The untouched field keeps the stored leaf rather than being rewritten by
    # the patch.
    assert Map.take(view["data"]["fields"]["done"], ["type", "value", "update_id"]) == %{
             "type" => "lww",
             "value" => false,
             "update_id" => read_body["data"]["fields"]["done"]["update_id"]
           }
  end

  test "removes one stored edge and leaves the source's other edges", %{dir: dir} do
    name = "unlinkStoredLabel"
    actor_id = unique("a")
    group_id = unique("g")
    todo_id = unique("todo")

    seed_member(actor_id, group_id, [
      "function." <> name,
      "todo.create",
      "todo.update",
      "ebb/link.create",
      "ebb/link.update"
    ])

    hlc = generate_hlc()

    assert write_entity_in_group(actor_id, todo_id, "todo", group_id, %{
             "title" => %{"value" => "linked", "hlc" => hlc}
           }).status == 200

    # Two edges stored before the invocation, as the client writes them.
    assert seed_edges(actor_id, todo_id, ["e_l1", "e_l2"]).status == 200

    BunSupport.deploy_fixture!(dir, name)
    configure_bun(dir)

    before = WatermarkTracker.committed_watermark()

    response =
      post_function(
        name,
        Jason.encode!(%{"todo_id" => todo_id, "label_id" => "e_l1"}),
        actor_id
      )

    assert response.status == 200
    assert WatermarkTracker.committed_watermark() == before + 1
    assert [action] = ActionLog.read(before + 1, before + 1)

    [todo_update] = Enum.filter(action["updates"], &(&1["subject_id"] == todo_id))
    assert todo_update["method"] == "merge"
    assert todo_update["component"] == "ebb/link"
    assert [{"labels", "todo", "e_l1", %{"value" => nil}}] = link_edges(todo_update["data"])

    # The row keeps its title, and only the named edge is tombstoned: the
    # source's other edges are untouched, which is what a per-key removal buys.
    read = get_entity(todo_id, actor_id)
    assert read.status == 200
    read_entity = Jason.decode!(read.resp_body)
    assert read_entity["data"]["fields"]["title"]["value"] == "linked"

    edges =
      for {field, type, target, leaf} <- link_edges(read_entity["data"]["fields"]["link"]),
          do: {field, type, target, leaf["value"]}

    assert Enum.sort(edges) == [{"labels", "todo", "e_l1", nil}, {"labels", "todo", "e_l2", true}]
  end

  # --- setup helpers -------------------------------------------------------

  defp params(group_id), do: Jason.encode!(%{"group_id" => group_id})

  defp params_with_title(group_id, title) do
    Jason.encode!(%{"group_id" => group_id, "title" => title})
  end

  defp params_with_project(group_id, project_id) do
    Jason.encode!(%{"group_id" => group_id, "project_id" => project_id})
  end

  # The Action a client would submit for the same forbidden patch: same
  # server-derived id, same entity, same verb.
  defp foreign_patch(action_id, actor_id, todo_id) do
    hlc = generate_hlc()
    update_id = unique("upd_fn")

    %{
      "id" => action_id,
      "actor_id" => actor_id,
      "hlc" => hlc,
      "updates" => [
        %{
          "id" => update_id,
          "subject_id" => todo_id,
          "component" => "todo/title",
          "method" => "merge",
          "data" => %{
            "type" => "lww",
            "value" => "overwritten",
            "update_id" => update_id,
            "hlc" => hlc
          }
        }
      ]
    }
  end

  # The endpoint's plug pipeline fetches query params before the router reads
  # the `components` parameter; calling the router directly does not.
  defp get_entity(id, actor_id \\ "a_test") do
    Plug.Test.conn(:get, "/entities/#{id}")
    |> Plug.Conn.put_req_header("x-ebb-actor-id", actor_id)
    |> Plug.Conn.fetch_query_params()
    |> EbbServer.Sync.Router.call([])
  end
end
