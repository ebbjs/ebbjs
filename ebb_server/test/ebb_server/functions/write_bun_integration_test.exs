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

  import EbbServer.Integration.ActionHelpers
  import EbbServer.LiveStreamHelpers, only: [start_live_stream: 2]
  import EbbServer.SSEHelpers, only: [data_payloads: 1]
  import EbbServer.TestHelpers, only: [generate_hlc: 0]
  import Plug.Conn
  import Plug.Test

  alias EbbServer.Functions.BundleCache
  alias EbbServer.Functions.Worker.Bun, as: BunWorker
  alias EbbServer.Storage.{ActionLog, CacheTables, RelationshipCache, WatermarkTracker}
  alias EbbServer.Sync.Router
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
    configure_boot(dir)

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
    assert overlay["type"] == "todo"
    assert overlay["deleted_hlc"] == nil
    # A row this invocation created has no GSN yet, and the overlay carries
    # the write's own HLCs rather than the stored row's.
    assert overlay["last_gsn"] == 0
    assert is_binary(overlay["created_hlc"])
    assert overlay["created_hlc"] == overlay["updated_hlc"]
    assert overlay["data"]["fields"]["title"] == title

    # The same write is durable and readable through the ordinary endpoint.
    read = get_entity(created_id, actor_id)
    assert read.status == 200
    entity = Jason.decode!(read.resp_body)
    assert entity["id"] == created_id
    assert entity["type"] == "todo"
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
             &(&1["subject_id"] == created_id and &1["subject_type"] == "todo" and
                 &1["method"] == "put")
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
      "project.create"
    ])

    BunSupport.deploy_fixture!(dir, name)
    configure_boot(dir)

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

    # Two creates (each entity put plus its membership row), one patch, one
    # one-cardinality relationship put.
    assert length(updates) == 6
    assert Enum.count(updates, &(&1["subject_type"] == "entityGroup")) == 2

    [patch] = Enum.filter(updates, &(&1["method"] == "patch"))
    assert patch["subject_id"] == todo_id
    assert patch["data"]["fields"]["done"]["value"] == true

    [relationship] = Enum.filter(updates, &(&1["subject_type"] == "relationship"))
    assert relationship["method"] == "put"
    assert relationship["data"]["fields"]["source_id"]["value"] == todo_id
    assert relationship["data"]["fields"]["target_id"]["value"] == project_id
  end

  test "a handler that throws after a create leaves nothing", %{dir: dir} do
    name = "createThenThrow"
    actor_id = unique("a")
    group_id = unique("g")
    doomed_id = unique("todo_fn")

    seed_member(actor_id, group_id, ["function." <> name, "todo.create", "todo.read"])

    BunSupport.deploy_fixture!(dir, name)
    configure_boot(dir)

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
    configure_boot(dir)

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
    configure_boot(dir)

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
      "relationship.delete"
    ])

    assert write_entity_in_group(actor_id, project_id, "project", group_id, fields("a project")).status ==
             200

    BunSupport.deploy_fixture!(dir, name)
    configure_boot(dir)

    stream = start_live_stream(group_id, actor_id)
    before = WatermarkTracker.committed_watermark()

    response = post_function(name, params_with_project(group_id, project_id), actor_id)

    assert response.status == 200
    body = Jason.decode!(response.resp_body)
    created_id = body["result"]["id"]

    assert WatermarkTracker.committed_watermark() == before + 1
    assert [action] = ActionLog.read(before + 1, before + 1)
    assert action["gsn"] == before + 1

    relationship_updates = Enum.filter(action["updates"], &(&1["subject_type"] == "relationship"))
    assert Enum.map(relationship_updates, & &1["method"]) |> Enum.sort() == ["delete", "put"]
    assert [relationship_id] = relationship_updates |> Enum.map(& &1["subject_id"]) |> Enum.uniq()

    # The row the put created was deleted by the same Action, so it is gone
    # from the cache the reader paths use.
    assert RelationshipCache.get_relationship(
             relationship_id,
             CacheTables.relationships_by_id()
           ) == nil

    # And the delete was scoped to the source's group, so a live subscriber
    # receives it rather than a link that silently survives delivery.
    assert_receive {:chunk_written, bytes}, @await_timeout_ms
    assert [payload] = data_payloads(bytes)
    event = Jason.decode!(payload)
    assert event["gsn"] == before + 1

    live_relationship_updates =
      Enum.filter(event["updates"], &(&1["subject_type"] == "relationship"))

    assert Enum.map(live_relationship_updates, & &1["method"]) |> Enum.sort() == ["delete", "put"]
    assert Enum.all?(live_relationship_updates, &(&1["subject_id"] == relationship_id))
    refute Enum.any?(live_relationship_updates, &(&1["subject_id"] == created_id))

    Task.shutdown(stream, :brutal_kill)
  end

  # --- setup helpers -------------------------------------------------------

  defp unique(prefix), do: "#{prefix}_#{System.unique_integer([:positive])}"

  defp seed_member(actor_id, group_id, permissions) do
    assert bootstrap_group(actor_id, group_id, permissions).status == 200
  end

  defp fields(title) do
    hlc = generate_hlc()
    %{"title" => %{"type" => "lww", "value" => title, "hlc" => hlc}}
  end

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
          "subject_type" => "todo",
          "method" => "patch",
          "data" => %{
            "fields" => %{
              "title" => %{
                "type" => "lww",
                "value" => "overwritten",
                "update_id" => update_id,
                "hlc" => hlc
              }
            }
          }
        }
      ]
    }
  end

  defp configure_boot(dir) do
    previous = Application.get_env(:ebb_server, :functions)

    Application.put_env(
      :ebb_server,
      :functions,
      Keyword.merge([enabled: true, bundle_dir: dir],
        transport: BunWorker,
        worker_opts: BunSupport.transport_opts(dir)
      )
    )

    on_exit(fn ->
      case previous do
        nil -> Application.delete_env(:ebb_server, :functions)
        value -> Application.put_env(:ebb_server, :functions, value)
      end
    end)
  end

  defp start_cache(dir) do
    start_supervised!({BundleCache, loader_opts: [dir: dir]})
  end

  defp post_function(name, body, actor_id, headers \\ []) do
    conn(:post, "/functions/#{name}", body)
    |> put_req_header("content-type", "application/json")
    |> put_req_header("x-ebb-actor-id", actor_id)
    |> put_request_headers(headers)
    |> Router.call([])
  end

  defp put_request_headers(conn, headers) do
    Enum.reduce(headers, conn, fn {name, value}, conn -> put_req_header(conn, name, value) end)
  end

  defp action_id_for(invocation_id) do
    digest = Base.encode16(:crypto.hash(:sha256, invocation_id), case: :lower)
    "a_" <> binary_part(digest, 0, 16)
  end
end
