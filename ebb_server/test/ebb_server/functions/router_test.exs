defmodule EbbServer.Functions.RouterTest do
  use ExUnit.Case, async: false

  import EbbServer.TestHelpers, only: [create_isolated_tables: 0, put_actor: 2]
  import Plug.Conn
  import Plug.Test

  alias EbbServer.Functions.{Bundle, BundleCache, Protocol}
  alias EbbServer.Functions.Bundle.StoreLoader
  alias EbbServer.Functions.Router
  alias EbbServer.Functions.Store
  alias EbbServer.Functions.Worker.Fake
  alias EbbServer.Storage.GroupCache
  alias EbbServer.Sync.Router, as: SyncRouter
  alias EbbServer.TestHelpers

  alias EbbServer.TestFunctions.{Bundles, InputScriptedWorker}

  @actor "a_functions_router"
  @intruder "a_functions_intruder"
  @grant_group "g_functions"

  setup do
    tables = create_isolated_tables()
    dir = Bundles.tmp_bundle_dir()
    cache = start_supervised!({BundleCache, name: nil, loader_opts: [dir: dir]})

    %{dir: dir, cache: cache, tables: tables, table: tables.group_members}
  end

  # The flag, the bundle directory, and the transport are node configuration,
  # so tests set them through the same nested key an operator would and put
  # back whatever was there.
  defp configure_boot(config) do
    previous = Application.get_env(:ebb_server, :functions)

    Application.put_env(:ebb_server, :functions, Keyword.merge([enabled: true], config))

    on_exit(fn ->
      case previous do
        nil -> Application.delete_env(:ebb_server, :functions)
        value -> Application.put_env(:ebb_server, :functions, value)
      end
    end)
  end

  defp grant(tables, actor_id, permissions) do
    :ok =
      GroupCache.put_group_member(
        %{
          id: "gm_#{System.unique_integer([:positive])}",
          actor_id: actor_id,
          group_id: @grant_group,
          permissions: permissions
        },
        group_members: tables.group_members,
        group_members_by_id: tables.group_members_by_id,
        group_members_by_group: tables.group_members_by_group
      )
  end

  # The router is mounted under `/functions`; `Plug.forward/4` strips the
  # prefix in production, so calling it directly means passing the bare name.
  # The parent router passes no options, so it reads the group_members table
  # the way a booted node does. Publishing the isolated table for this test is
  # the same redirect `start_isolated_cache/0` performs.
  defp publish_group_members_table(table) do
    key = {GroupCache, :group_members}
    previous = :persistent_term.get(key, :unset)

    :persistent_term.put(key, table)

    on_exit(fn ->
      case previous do
        :unset -> :persistent_term.erase(key)
        value -> :persistent_term.put(key, value)
      end
    end)
  end

  defp post_function(%{cache: cache, table: table}, name, body, actor_id \\ @actor, headers \\ []) do
    conn(:post, "/#{name}", body)
    |> put_req_header("content-type", "application/json")
    |> put_headers(headers)
    |> put_actor(actor_id)
    |> Router.call(Router.init(cache: cache, group_members_table: table))
  end

  defp put_headers(conn, headers) do
    Enum.reduce(headers, conn, fn {name, value}, conn -> put_req_header(conn, name, value) end)
  end

  defp post_through_sync(name, body, actor_id \\ @actor) do
    conn(:post, "/functions/#{name}", body)
    |> put_req_header("content-type", "application/json")
    |> put_req_header("x-ebb-actor-id", actor_id)
    |> SyncRouter.call([])
  end

  defp scripted_fake(value) do
    [
      %{"expect" => %{"type" => "invoke"}},
      %{"send" => Protocol.result({:ok, value})}
    ]
  end

  describe "the route while the flag is off" do
    test "falls through to the parent's unknown-path 404, with no functions vocabulary" do
      configure_boot(enabled: false, bundle_dir: "/nonexistent")

      conn = post_through_sync("anything", "{}")

      assert conn.status == 404
      assert conn.resp_body == ""
      assert get_resp_header(conn, "x-ebb-invocation-id") == []
      refute conn.resp_body =~ "disabled"
    end

    test "GET /functions falls through too" do
      configure_boot(enabled: false, bundle_dir: "/nonexistent")

      conn =
        conn(:get, "/functions")
        |> put_req_header("x-ebb-actor-id", @actor)
        |> SyncRouter.call([])

      assert conn.status == 404
      assert conn.resp_body == ""
    end
  end

  describe "the whole /functions subtree" do
    test "GET /functions reaches the child router through the parent when the flag is on", ctx do
      publish_group_members_table(ctx.table)

      start_supervised!(
        Supervisor.child_spec(
          {Store, data_dir: TestHelpers.tmp_dir(ctx)},
          id: :functions_registered_store
        )
      )

      start_supervised!(
        Supervisor.child_spec(
          {BundleCache, loader: StoreLoader, loader_opts: [store: Store]},
          id: :functions_registered_store_cache
        )
      )

      configure_boot(transport: InputScriptedWorker)

      conn =
        conn(:get, "/functions")
        |> put_req_header("x-ebb-actor-id", @actor)
        |> SyncRouter.call([])

      assert conn.status == 200
      assert Jason.decode!(conn.resp_body) == %{"functions" => []}
    end
  end

  describe "a granted invocation" do
    test "answers the success envelope and headers through the scripted fake", ctx do
      name = "echoBack"
      Bundles.write_bundle!(ctx.dir, Bundles.envelope(name))
      grant(ctx.tables, @actor, ["function." <> name])

      configure_boot(
        bundle_dir: ctx.dir,
        transport: Fake,
        worker_opts: [script: scripted_fake(%{"ok" => true})]
      )

      conn = post_function(ctx, name, ~s({"text":"hello"}))

      assert conn.status == 200
      body = Jason.decode!(conn.resp_body)
      assert body["ok"] == true
      assert body["result"] == %{"ok" => true}
      assert body["version"] == "1.0.0"
      assert "inv_" <> id_suffix = body["invocation_id"]
      assert byte_size(id_suffix) == 16
      assert id_suffix =~ ~r/\A[0-9a-z]{16}\z/

      assert get_resp_header(conn, "x-ebb-invocation-id") == [body["invocation_id"]]
      assert get_resp_header(conn, "x-ebb-function-version") == ["1.0.0"]
    end

    test "is reachable through the parent router when the flag is on", ctx do
      name = "echoBack"
      Bundles.write_bundle!(ctx.dir, Bundles.envelope(name))
      publish_group_members_table(ctx.table)
      grant(ctx.tables, @actor, ["function.*"])

      # The parent passes no router options, so it asks the registered cache
      # the same way a booted node with functions enabled would. The setup
      # cache is unnamed and running, so this one gets its own child id.
      start_supervised!(
        Supervisor.child_spec({BundleCache, loader_opts: [dir: ctx.dir]},
          id: :functions_registered_cache
        )
      )

      configure_boot(bundle_dir: ctx.dir, transport: InputScriptedWorker)

      conn = post_through_sync(name, ~s({"ping":true}))

      assert conn.status == 200
      assert Jason.decode!(conn.resp_body)["result"] == %{"echo" => %{"ping" => true}}
    end

    test "an empty body is no parameters", ctx do
      name = "noInputFunction"
      Bundles.write_bundle!(ctx.dir, Bundles.envelope(name))
      grant(ctx.tables, @actor, ["function.*"])
      configure_boot(bundle_dir: ctx.dir, transport: InputScriptedWorker)

      conn = post_function(ctx, name, "")

      assert conn.status == 200
      assert Jason.decode!(conn.resp_body)["result"] == %{"echo" => %{}}
    end

    test "authenticated access needs no grant", ctx do
      name = "openFunction"
      Bundles.write_bundle!(ctx.dir, Bundles.envelope(name, %{"access" => "authenticated"}))
      configure_boot(bundle_dir: ctx.dir, transport: InputScriptedWorker)

      conn = post_function(ctx, name, "{}")

      assert conn.status == 200
      assert Jason.decode!(conn.resp_body)["result"] == %{"echo" => %{}}
    end
  end

  describe "the Idempotency-Key header" do
    setup ctx do
      name = "idempotentEcho"
      Bundles.write_bundle!(ctx.dir, Bundles.envelope(name))
      grant(ctx.tables, @actor, ["function.*"])
      %{name: name}
    end

    test "a key reproduces the same invocation id on a retry", ctx do
      configure_boot(
        bundle_dir: ctx.dir,
        transport: Fake,
        worker_opts: [script: scripted_fake(%{"ok" => true})]
      )

      key = "retry-me"
      first = ctx |> post_function(ctx.name, "{}", @actor, [{"idempotency-key", key}])
      second = ctx |> post_function(ctx.name, "{}", @actor, [{"idempotency-key", key}])

      assert first.status == 200
      assert second.status == 200

      expected = derived_invocation_id(ctx.name, @actor, key)
      assert Jason.decode!(first.resp_body)["invocation_id"] == expected
      assert Jason.decode!(second.resp_body)["invocation_id"] == expected
      assert get_resp_header(second, "x-ebb-invocation-id") == [expected]
    end

    test "a different key is a different invocation", ctx do
      configure_boot(bundle_dir: ctx.dir, transport: InputScriptedWorker)

      one = post_function(ctx, ctx.name, "{}", @actor, [{"idempotency-key", "one"}])
      two = post_function(ctx, ctx.name, "{}", @actor, [{"idempotency-key", "two"}])

      assert Jason.decode!(one.resp_body)["invocation_id"] ==
               derived_invocation_id(ctx.name, @actor, "one")

      assert Jason.decode!(two.resp_body)["invocation_id"] ==
               derived_invocation_id(ctx.name, @actor, "two")
    end

    test "the same key from another actor or for another function is a different invocation",
         ctx do
      configure_boot(bundle_dir: ctx.dir, transport: InputScriptedWorker)

      other_actor = @actor <> "_other"
      other_name = "idempotentEchoOther"
      Bundles.write_bundle!(ctx.dir, Bundles.envelope(other_name))
      grant(ctx.tables, other_actor, ["function.*"])

      first = post_function(ctx, ctx.name, "{}", @actor, [{"idempotency-key", "shared"}])

      scoped_actor =
        post_function(ctx, ctx.name, "{}", other_actor, [{"idempotency-key", "shared"}])

      scoped_function =
        post_function(ctx, other_name, "{}", @actor, [{"idempotency-key", "shared"}])

      assert first.status == 200
      assert scoped_actor.status == 200
      assert scoped_function.status == 200

      ids =
        [first, scoped_actor, scoped_function]
        |> Enum.map(&Jason.decode!(&1.resp_body)["invocation_id"])

      assert ids == Enum.uniq(ids)
    end

    test "no key mints a fresh id per request", ctx do
      configure_boot(bundle_dir: ctx.dir, transport: InputScriptedWorker)

      first = Jason.decode!(post_function(ctx, ctx.name, "{}").resp_body)["invocation_id"]
      second = Jason.decode!(post_function(ctx, ctx.name, "{}").resp_body)["invocation_id"]

      refute first == second
      assert "inv_" <> suffix = first
      assert suffix =~ ~r/\A[0-9a-z]{16}\z/
    end

    test "a key at the 255-byte bound is accepted", ctx do
      configure_boot(bundle_dir: ctx.dir, transport: InputScriptedWorker)

      key = String.duplicate("k", 255)
      conn = post_function(ctx, ctx.name, "{}", @actor, [{"idempotency-key", key}])

      assert conn.status == 200

      assert Jason.decode!(conn.resp_body)["invocation_id"] ==
               derived_invocation_id(ctx.name, @actor, key)
    end

    test "an empty or over-long key is a 400 rather than a derived id", ctx do
      configure_boot(
        bundle_dir: ctx.dir,
        transport: InputScriptedWorker,
        worker_opts: [notify: self()]
      )

      for key <- ["", String.duplicate("k", 256)] do
        conn = post_function(ctx, ctx.name, "{}", @actor, [{"idempotency-key", key}])

        assert conn.status == 400
        body = Jason.decode!(conn.resp_body)
        assert body["error"] == "invalid_idempotency_key"
        assert body["details"] =~ "Idempotency-Key"
        assert "inv_" <> _fresh = body["invocation_id"]
        assert get_resp_header(conn, "x-ebb-invocation-id") == [body["invocation_id"]]
      end

      refute_received :functions_worker_started
    end

    test "a repeated header is a 400 because the requests disagree", ctx do
      configure_boot(bundle_dir: ctx.dir, transport: InputScriptedWorker)

      # `put_req_header/3` replaces, so a repeated header needs the prepend form.
      conn =
        conn(:post, "/#{ctx.name}", "{}")
        |> put_req_header("content-type", "application/json")
        |> prepend_req_headers([
          {"idempotency-key", "one"},
          {"idempotency-key", "two"}
        ])
        |> put_actor(@actor)
        |> Router.call(Router.init(cache: ctx.cache, group_members_table: ctx.table))

      assert conn.status == 400
      assert Jason.decode!(conn.resp_body)["error"] == "invalid_idempotency_key"
    end
  end

  describe "a result the envelope cannot carry" do
    test "is a 500 in the envelope rather than a crash", ctx do
      name = "whateverFunction"
      Bundles.write_bundle!(ctx.dir, Bundles.envelope(name))
      grant(ctx.tables, @actor, ["function.*"])

      # A pid is not Jason-encodable; only a misbehaving worker could send it.
      configure_boot(
        bundle_dir: ctx.dir,
        transport: Fake,
        worker_opts: [script: scripted_fake(%{"bad" => self()})]
      )

      conn = post_function(ctx, name, "{}")

      assert conn.status == 500
      body = Jason.decode!(conn.resp_body)
      assert body["error"] == "internal_error"
      assert body["details"] == "response could not be encoded"
      assert String.starts_with?(body["invocation_id"], "inv_")
    end
  end

  describe "a failure the worker reports" do
    test "a thrown handler is 422 handler_error with its message", ctx do
      name = "throwingFunction"
      Bundles.write_bundle!(ctx.dir, Bundles.envelope(name))
      grant(ctx.tables, @actor, ["function.*"])

      configure_boot(
        bundle_dir: ctx.dir,
        transport: Fake,
        worker_opts: [
          script: [
            %{"expect" => %{"type" => "invoke"}},
            %{"send" => Protocol.result({:error, "handler_error", "boom"})}
          ]
        ]
      )

      conn = post_function(ctx, name, "{}")

      assert conn.status == 422
      body = Jason.decode!(conn.resp_body)
      assert body["error"] == "handler_error"
      assert body["details"] == "boom"
      assert body["version"] == "1.0.0"
      refute Map.has_key?(body, "retryable")
    end

    test "an unrecognized result kind is 500 runner_error", ctx do
      name = "oddFunction"
      Bundles.write_bundle!(ctx.dir, Bundles.envelope(name))
      grant(ctx.tables, @actor, ["function.*"])

      configure_boot(
        bundle_dir: ctx.dir,
        transport: Fake,
        worker_opts: [
          script: [
            %{"expect" => %{"type" => "invoke"}},
            %{"send" => Protocol.result({:error, "out_of_memory", "killed"})}
          ]
        ]
      )

      conn = post_function(ctx, name, "{}")

      assert conn.status == 500
      body = Jason.decode!(conn.resp_body)
      assert body["error"] == "runner_error"
      assert body["details"] == "killed"
    end
  end

  describe "refusals before a worker exists" do
    test "an unknown function is a 404 that still names the invocation", ctx do
      configure_boot(bundle_dir: ctx.dir, transport: InputScriptedWorker)

      conn = post_function(ctx, "neverDeployed", "{}")

      assert conn.status == 404
      body = Jason.decode!(conn.resp_body)
      assert body["error"] == "not_found"
      assert body["version"] == nil
      assert String.starts_with?(body["invocation_id"], "inv_")
      assert get_resp_header(conn, "x-ebb-invocation-id") == [body["invocation_id"]]
      assert get_resp_header(conn, "x-ebb-function-version") == []
    end

    test "a denied actor is a 403 and spawns nothing", ctx do
      name = "secureFunction"
      Bundles.write_bundle!(ctx.dir, Bundles.envelope(name))

      configure_boot(
        bundle_dir: ctx.dir,
        transport: InputScriptedWorker,
        worker_opts: [notify: self()]
      )

      conn = post_function(ctx, name, "{}", @intruder)

      assert conn.status == 403
      body = Jason.decode!(conn.resp_body)
      assert body["error"] == "denied"
      assert body["version"] == "1.0.0"
      assert String.starts_with?(body["invocation_id"], "inv_")
      refute_received :functions_worker_started
    end

    test "a malformed body is a 400", ctx do
      name = "echoBack"
      Bundles.write_bundle!(ctx.dir, Bundles.envelope(name))
      grant(ctx.tables, @actor, ["function.*"])
      configure_boot(bundle_dir: ctx.dir, transport: InputScriptedWorker)

      conn = post_function(ctx, name, ~s({"text":))

      assert conn.status == 400
      assert Jason.decode!(conn.resp_body)["error"] == "invalid_json"
    end

    test "a body that is not a JSON object is a 400", ctx do
      name = "echoBack"
      Bundles.write_bundle!(ctx.dir, Bundles.envelope(name))
      grant(ctx.tables, @actor, ["function.*"])
      configure_boot(bundle_dir: ctx.dir, transport: InputScriptedWorker)

      conn = post_function(ctx, name, "[1,2,3]")

      assert conn.status == 400
      assert Jason.decode!(conn.resp_body)["error"] == "invalid_json"
    end

    test "through the parent router an anonymous request gets AuthPlug's 401", ctx do
      configure_boot(bundle_dir: ctx.dir, transport: InputScriptedWorker)

      conn = conn(:post, "/functions/anything", "{}") |> SyncRouter.call([])

      assert conn.status == 401
      body = Jason.decode!(conn.resp_body)
      assert body["error"] == "unauthorized"
      assert body["details"] == "missing x-ebb-actor-id header"
      assert get_resp_header(conn, "x-ebb-invocation-id") == []
      assert get_resp_header(conn, "x-ebb-function-version") == []
    end

    test "a missing actor is a 401 in the shared envelope", ctx do
      name = "echoBack"
      Bundles.write_bundle!(ctx.dir, Bundles.envelope(name))
      configure_boot(bundle_dir: ctx.dir, transport: InputScriptedWorker)

      conn =
        conn(:post, "/#{name}", "{}")
        |> Router.call(Router.init(cache: ctx.cache, group_members_table: ctx.table))

      assert conn.status == 401
      body = Jason.decode!(conn.resp_body)
      assert body["error"] == "unauthorized"
      assert String.starts_with?(body["invocation_id"], "inv_")
    end
  end

  describe "size limits" do
    test "an oversize request body is a 413 without being buffered whole", ctx do
      name = "echoBack"
      Bundles.write_bundle!(ctx.dir, Bundles.envelope(name))
      grant(ctx.tables, @actor, ["function.*"])
      configure_boot(bundle_dir: ctx.dir, transport: InputScriptedWorker)

      body = Jason.encode!(%{"pad" => String.duplicate("a", Protocol.max_frame_bytes())})
      conn = post_function(ctx, name, body)

      assert conn.status == 413
      assert Jason.decode!(conn.resp_body)["error"] == "payload_too_large"
    end

    test "a bundle whose invoke frame would exceed the frame bound is a 413", ctx do
      name = "hugeFunction"
      code = "export const hugeFunction = () => 1; " <> String.duplicate("//", 1_100_000)
      envelope = Bundles.envelope(name, %{"digest" => Bundle.digest_for(code)})
      Bundles.write_bundle!(ctx.dir, envelope, code)
      grant(ctx.tables, @actor, ["function.*"])
      configure_boot(bundle_dir: ctx.dir, transport: InputScriptedWorker)

      conn = post_function(ctx, name, "{}")

      assert conn.status == 413
      body = Jason.decode!(conn.resp_body)
      assert body["error"] == "payload_too_large"
      assert body["version"] == "1.0.0"
      assert String.starts_with?(body["invocation_id"], "inv_")
    end
  end

  describe "bundle failures" do
    test "a tampered bundle is a 500, never a 404", ctx do
      name = "tamperedFunction"

      Bundles.write_bundle!(
        ctx.dir,
        Bundles.envelope(name, %{"digest" => "sha256:" <> String.duplicate("0", 64)})
      )

      grant(ctx.tables, @actor, ["function.*"])
      configure_boot(bundle_dir: ctx.dir, transport: InputScriptedWorker)

      conn = post_function(ctx, name, "{}")

      assert conn.status == 500
      body = Jason.decode!(conn.resp_body)
      assert body["error"] == "internal_error"
      assert body["details"] == "bundle digest does not match its code"
    end

    test "an invalid bundle is a 500 that says so", ctx do
      name = "brokenFunction"
      Bundles.write_bundle!(ctx.dir, Bundles.envelope(name, %{"contract" => 99}))
      grant(ctx.tables, @actor, ["function.*"])
      configure_boot(bundle_dir: ctx.dir, transport: InputScriptedWorker)

      conn = post_function(ctx, name, "{}")

      assert conn.status == 500
      assert Jason.decode!(conn.resp_body)["details"] == "the active bundle is invalid"
    end

    test "a bundle directory that disappeared is a 500", ctx do
      name = "goneFunction"
      Bundles.write_bundle!(ctx.dir, Bundles.envelope(name))
      grant(ctx.tables, @actor, ["function.*"])
      configure_boot(bundle_dir: ctx.dir, transport: InputScriptedWorker)
      File.rm_rf!(ctx.dir)

      conn = post_function(ctx, name, "{}")

      assert conn.status == 500
      assert Jason.decode!(conn.resp_body)["details"] == "the bundle could not be loaded"
    end

    test "two bundles claiming one version are a 500", ctx do
      name = "duplicatedFunction"
      envelope = Bundles.envelope(name)
      Bundles.write_envelope!(ctx.dir, envelope, "1.0.0")
      Bundles.write_envelope!(ctx.dir, envelope, "1.0.0-dup")
      grant(ctx.tables, @actor, ["function.*"])
      configure_boot(bundle_dir: ctx.dir, transport: InputScriptedWorker)

      conn = post_function(ctx, name, "{}")

      assert conn.status == 500

      assert Jason.decode!(conn.resp_body)["details"] ==
               "more than one bundle is deployed as version 1.0.0"
    end

    test "a cache that is not running is a 500 in the envelope", ctx do
      configure_boot(bundle_dir: ctx.dir, transport: InputScriptedWorker)

      conn =
        conn(:post, "/echoBack", "{}")
        |> put_actor(@actor)
        |> Router.call(
          Router.init(cache: :functions_cache_that_is_not_running, group_members_table: ctx.table)
        )

      assert conn.status == 500
      body = Jason.decode!(conn.resp_body)
      assert body["error"] == "internal_error"
      assert body["details"] == "bundle cache is unavailable"
    end
  end

  describe "the deadline" do
    test "maps to 408 retryable and the router keeps serving", ctx do
      name = "slowFunction"
      Bundles.write_bundle!(ctx.dir, Bundles.envelope(name, %{"timeoutMs" => 50}))
      grant(ctx.tables, @actor, ["function.*"])

      configure_boot(
        bundle_dir: ctx.dir,
        transport: InputScriptedWorker,
        worker_opts: [notify: self()]
      )

      timed_out = post_function(ctx, name, ~s({"hang": true}))

      assert timed_out.status == 408
      body = Jason.decode!(timed_out.resp_body)
      assert body["error"] == "timeout"
      assert body["retryable"] == true
      assert body["version"] == "1.0.0"

      second = post_function(ctx, name, ~s({"after":"timeout"}))

      assert second.status == 200
      assert Jason.decode!(second.resp_body)["result"] == %{"echo" => %{"after" => "timeout"}}
      assert Jason.decode!(second.resp_body)["invocation_id"] != body["invocation_id"]
    end
  end

  defp derived_invocation_id(name, actor_id, key) do
    digest =
      :crypto.hash(:sha256, [actor_id, "\n", name, "\n", key])
      |> Base.encode16(case: :lower)

    "inv_" <> binary_part(digest, 0, 16)
  end

  describe "params validation before a worker exists" do
    test "an input that fails the params schema is 400 invalid_input and spawns nothing", ctx do
      name = "validatedFunction"

      params_schema = %{
        "type" => "object",
        "required" => ["text"],
        "properties" => %{"text" => %{"type" => "string"}}
      }

      Bundles.write_bundle!(ctx.dir, Bundles.envelope(name, %{"paramsSchema" => params_schema}))
      grant(ctx.tables, @actor, ["function.*"])

      configure_boot(
        bundle_dir: ctx.dir,
        transport: InputScriptedWorker,
        worker_opts: [notify: self()]
      )

      conn = post_function(ctx, name, ~s({"text":3}))

      assert conn.status == 400
      body = Jason.decode!(conn.resp_body)
      assert body["error"] == "invalid_input"
      assert [issue] = body["issues"]
      assert issue["path"] == "text"
      assert is_binary(issue["message"])
      refute Map.has_key?(body, "details")
      assert body["version"] == "1.0.0"
      assert String.starts_with?(body["invocation_id"], "inv_")
      refute_received :functions_worker_started
    end

    test "a valid input still reaches the worker", ctx do
      name = "validatedEcho"

      params_schema = %{
        "type" => "object",
        "properties" => %{"text" => %{"type" => "string"}}
      }

      Bundles.write_bundle!(ctx.dir, Bundles.envelope(name, %{"paramsSchema" => params_schema}))
      grant(ctx.tables, @actor, ["function.*"])
      configure_boot(bundle_dir: ctx.dir, transport: InputScriptedWorker)

      conn = post_function(ctx, name, ~s({"text":"hello"}))

      assert conn.status == 200
      assert Jason.decode!(conn.resp_body)["result"] == %{"echo" => %{"text" => "hello"}}
    end
  end

  describe "output validation" do
    test "a result that fails the output schema is 422 invalid_output with its ids", ctx do
      name = "outputFunction"

      Bundles.write_bundle!(
        ctx.dir,
        Bundles.envelope(name, %{"outputSchema" => %{"type" => "string"}})
      )

      grant(ctx.tables, @actor, ["function.*"])

      configure_boot(
        bundle_dir: ctx.dir,
        transport: Fake,
        worker_opts: [script: scripted_fake(42)]
      )

      conn = post_function(ctx, name, "{}")

      assert conn.status == 422
      body = Jason.decode!(conn.resp_body)
      assert body["error"] == "invalid_output"
      assert [_ | _] = body["issues"]
      assert body["version"] == "1.0.0"
      assert String.starts_with?(body["invocation_id"], "inv_")
      assert get_resp_header(conn, "x-ebb-invocation-id") == [body["invocation_id"]]
      assert get_resp_header(conn, "x-ebb-function-version") == ["1.0.0"]
    end
  end

  describe "methods the route does not have" do
    test "a non-POST request answers as the parent's catch-all does", ctx do
      Bundles.write_bundle!(ctx.dir, Bundles.envelope("echoBack"))
      configure_boot(bundle_dir: ctx.dir, transport: InputScriptedWorker)

      conn =
        conn(:get, "/echoBack")
        |> put_actor(@actor)
        |> Router.call(Router.init(cache: ctx.cache, group_members_table: ctx.table))

      assert conn.status == 404
      assert conn.resp_body == ""
    end
  end
end
