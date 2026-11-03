defmodule EbbServer.Functions.BunIntegrationTest do
  @moduledoc """
  The M1 acceptance path: the same invocation through a real Bun process.

  The router-facing tests use the fake's replacement seam exactly as a node
  configures it (`transport: Functions.Worker.Bun` plus `worker_opts`), so the
  flag, authorization, bundle cache, host operations, and storage are the ones
  a deployment runs. The direct `Invocation` tests use `DelayedHost` to prove
  the runner matches replies by `call_id` rather than arrival order.

  Write-bound fixtures (`get-then-commit`, `commit-rejected`) are conformance
  fixtures for #594's runtime writes and are not run here; #593's runtime has
  `ctx.get` only.
  """

  use ExUnit.Case, async: false
  use EbbServer.Integration.StorageCase, with_auth_mode: true

  import EbbServer.FunctionsTestHelpers
  import EbbServer.Integration.ActionHelpers
  import Plug.Conn

  alias EbbServer.Functions.{Bundle, Invocation, Protocol}
  alias EbbServer.Functions.Worker.Bun, as: BunWorker
  alias EbbServer.TestFunctions
  alias EbbServer.TestFunctions.{Bundles, DelayedHost, LocalHttp}

  alias EbbServer.TestFunctions.Bun, as: BunSupport

  @enabled_env "EBB_FUNCTIONS_ENABLED"
  @await_timeout_ms 10_000

  @moduletag :bun
  @moduletag skip:
               if(BunSupport.available?(),
                 do: false,
                 else: "Bun or packages/runner is not installed"
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

  describe "through the router" do
    test "an echo round-trips through a real Bun process", %{dir: dir} do
      name = "echoThroughBun"
      actor_id = unique("a")
      group_id = unique("g")

      seed_member(actor_id, group_id, ["function." <> name])

      deploy!(dir, name, "async (ctx, params) => ({ echo: params, actor: ctx.actor.id })")
      configure_bun(dir)

      response = post_function(name, ~s({"hello":"world"}), actor_id)

      assert response.status == 200
      body = Jason.decode!(response.resp_body)
      assert body["ok"] == true
      assert body["result"] == %{"echo" => %{"hello" => "world"}, "actor" => actor_id}
      assert body["version"] == "1.0.0"
      assert get_resp_header(response, "x-ebb-invocation-id") == [body["invocation_id"]]
    end

    test "ctx.get returns the entity view for a member", %{dir: dir} do
      name = "readDocument"
      actor_id = unique("a")
      group_id = unique("g")
      entity_id = unique("todo")

      seed_member(actor_id, group_id, ["function." <> name, "todo.read", "todo.create"])

      assert write_entity_in_group(actor_id, entity_id, "todo", group_id, fields("from bun")).status ==
               200

      deploy!(dir, name, "async (ctx) => ctx.get(#{inspect(entity_id)})")
      configure_bun(dir)

      # Read through the HTTP endpoint first so the entity is materialized; the
      # parity asserted below is about the same view, not about which request
      # happened to trigger lazy materialization.
      read = get_entity(entity_id, actor_id)
      assert read.status == 200

      response = post_function(name, "{}", actor_id)

      assert response.status == 200
      body = Jason.decode!(response.resp_body)
      view = body["result"]
      assert view["id"] == entity_id
      assert view["type"] == "todo"
      assert view["data"]["fields"]["title"]["value"] == "from bun"

      # The function sees the same view `/entities/:id` returns; the parity is
      # structural because both go through EntityView.for_actor/3. HLCs are
      # excluded because a first read can materialize a stale field HLC and a
      # later read corrects it — a storage timing detail, not a permission
      # difference.
      http_view = Jason.decode!(read.resp_body)

      assert Map.take(view, ["id", "type", "deleted_hlc", "last_gsn"]) ==
               Map.take(http_view, ["id", "type", "deleted_hlc", "last_gsn"])

      assert view["data"]["fields"]["title"]["value"] ==
               http_view["data"]["fields"]["title"]["value"]
    end

    test "ctx.get is null for an actor without the read permission", %{dir: dir} do
      name = "readSecret"
      actor_id = unique("a")
      member_group = unique("g")
      outsider_group = unique("g")
      entity_id = unique("todo")

      seed_member(actor_id, member_group, ["function." <> name, "todo.read", "todo.create"])

      assert write_entity_in_group(
               actor_id,
               entity_id,
               "todo",
               member_group,
               fields("members only")
             ).status == 200

      # The caller holds the function grant but not todo.read anywhere, so the
      # read must look exactly like a missing entity.
      outsider_id = unique("a")
      seed_member(outsider_id, outsider_group, ["function." <> name])

      deploy!(dir, name, "async (ctx) => ctx.get(#{inspect(entity_id)})")
      configure_bun(dir)

      allowed = post_function(name, "{}", actor_id)
      assert allowed.status == 200
      assert Jason.decode!(allowed.resp_body)["result"]["id"] == entity_id

      denied = post_function(name, "{}", outsider_id)
      assert denied.status == 200
      assert Jason.decode!(denied.resp_body)["result"] == nil

      # A denied read is the same answer the HTTP endpoint gives: not found.
      read = get_entity(entity_id, outsider_id)
      assert read.status == 404
    end

    test "native fetch works in the runner", %{dir: dir} do
      name = "fetchThroughBun"
      actor_id = unique("a")
      group_id = unique("g")

      seed_member(actor_id, group_id, ["function." <> name])

      server = LocalHttp.start(~s({"hello":"fetch"}))
      on_exit(fn -> LocalHttp.stop(server) end)

      deploy!(
        dir,
        name,
        "async (ctx, params) => { const r = await fetch(params.url); return { status: r.status, body: await r.json() }; }"
      )

      configure_bun(dir)

      response = post_function(name, Jason.encode!(%{"url" => server.url}), actor_id)

      assert response.status == 200

      assert Jason.decode!(response.resp_body)["result"] == %{
               "status" => 200,
               "body" => %{"hello" => "fetch"}
             }
    end

    test "a handler that exits ends the invocation without taking the endpoint down", %{dir: dir} do
      crashing = "crashingBun"
      after_crash = "afterCrashingBun"
      actor_id = unique("a")
      group_id = unique("g")

      seed_member(actor_id, group_id, ["function.*"])

      deploy!(dir, crashing, "async () => { process.exit(1); }")
      deploy!(dir, after_crash, "async () => ({ ok: true })")
      configure_bun(dir)

      response = post_function(crashing, "{}", actor_id)
      assert response.status == 503
      assert Jason.decode!(response.resp_body)["error"] == "unavailable"

      served = post_function(after_crash, "{}", actor_id)
      assert served.status == 200
      assert Jason.decode!(served.resp_body)["result"] == %{"ok" => true}
    end
  end

  describe "the wire conformance fixtures against a real runner" do
    test "every checked-in fixture is accounted for" do
      checked_in = MapSet.new(Enum.map(TestFunctions.fixture_names(), &(&1 <> ".json")))

      accounted =
        MapSet.new(~w(call-after-result.json commit-rejected.json crash.json frame-shapes.json
             get-then-commit.json handler-error.json out-of-order-get.json))

      assert MapSet.subset?(checked_in, accounted),
             "add the new fixture to this test: #{inspect(MapSet.difference(checked_in, accounted))}"
    end

    test "two reads overlap and replies are matched by call_id", %{dir: dir} do
      name = "readTwoThroughBun"

      code =
        deploy!(
          dir,
          name,
          "async (ctx) => Promise.all([ctx.get(\"e_slow\"), ctx.get(\"e_fast\")])"
        )

      assert {:ok, [%{"id" => "e_slow"}, %{"id" => "e_fast"}], nil} =
               Invocation.run(
                 transport: BunWorker,
                 invoke: invoke_frame(name, code, %{}),
                 worker_opts: BunSupport.transport_opts(dir),
                 host: DelayedHost,
                 host_opts: [delays: %{"e_slow" => 120, "e_fast" => 0}, notify: self()],
                 max_in_flight: 8,
                 deadline_ms: @await_timeout_ms
               )

      events = host_events(4)
      fast = Enum.find_index(events, &(&1 == {:host_finished, "e_fast"}))
      slow = Enum.find_index(events, &(&1 == {:host_finished, "e_slow"}))

      assert is_integer(fast) and is_integer(slow) and fast < slow,
             "expected the fast reply first, got #{inspect(events)}"
    end

    test "max_in_flight: 1 runs the same two reads serially", %{dir: dir} do
      name = "readTwoSerialInBun"

      code =
        deploy!(
          dir,
          name,
          "async (ctx) => Promise.all([ctx.get(\"e_slow\"), ctx.get(\"e_fast\")])"
        )

      assert {:ok, [%{"id" => "e_slow"}, %{"id" => "e_fast"}], nil} =
               Invocation.run(
                 transport: BunWorker,
                 invoke: invoke_frame(name, code, %{}),
                 worker_opts: BunSupport.transport_opts(dir),
                 host: DelayedHost,
                 host_opts: [delays: %{"e_slow" => 40, "e_fast" => 0}, notify: self()],
                 max_in_flight: 1,
                 deadline_ms: @await_timeout_ms
               )

      assert host_events(4) == [
               {:host_started, "e_slow"},
               {:host_finished, "e_slow"},
               {:host_started, "e_fast"},
               {:host_finished, "e_fast"}
             ]

      # The cap changes scheduling, not the frame shape: the runner still sent
      # both calls and matched both replies.
    end

    test "a thrown handler is 422 handler_error with no stack", %{dir: dir} do
      name = "throwsInBun"
      code = deploy!(dir, name, ~s|async () => { throw new Error("boom"); }|)

      assert {:error, 422, "handler_error", "boom", %{}} =
               Invocation.run(
                 transport: BunWorker,
                 invoke: invoke_frame(name, code, %{}),
                 worker_opts: BunSupport.transport_opts(dir),
                 deadline_ms: @await_timeout_ms
               )
    end

    test "a worker that exits without result is 503 and does not answer a call", %{dir: dir} do
      name = "crashesInBun"
      code = deploy!(dir, name, "async () => { process.exit(2); }")

      assert {:error, 503, "unavailable", message, %{}} =
               Invocation.run(
                 transport: BunWorker,
                 invoke: invoke_frame(name, code, %{}),
                 worker_opts: BunSupport.transport_opts(dir),
                 deadline_ms: @await_timeout_ms
               )

      assert message =~ "worker exited"
    end
  end

  # --- setup helpers -------------------------------------------------------

  defp host_events(count) do
    for _ <- 1..count do
      assert_receive event, @await_timeout_ms
      event
    end
  end

  # Returns the code so a direct-invocation test can put it in the frame.
  defp deploy!(dir, name, handler_js) do
    code = """
    var __ebbFunction = (() => {
      return { #{name}: #{handler_js} };
    })();
    """

    Bundles.write_bundle!(
      dir,
      Bundles.envelope(name, %{"digest" => Bundle.digest_for(code)}),
      code
    )

    code
  end

  defp invoke_frame(name, code, input) do
    Protocol.invoke(%{
      "invocation_id" => "inv_#{System.unique_integer([:positive])}",
      "name" => name,
      "version" => "1.0.0",
      "digest" => "sha256:" <> String.duplicate("0", 64),
      "bundle" => code,
      "entry" => name,
      "input" => input,
      "subject_actor_id" => "a_test",
      "env" => %{},
      "limits" => %{"timeout_ms" => @await_timeout_ms, "max_host_calls" => 1_000}
    })
  end
end
