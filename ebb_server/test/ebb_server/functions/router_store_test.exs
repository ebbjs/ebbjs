defmodule EbbServer.Functions.RouterStoreTest do
  @moduledoc """
  The deploy surface: upload, activate, list, and the store-backed invocation.

  These requests go through `EbbServer.Functions.Router` directly with an
  isolated `Functions.Store` and a `StoreLoader` cache, which is exactly the
  pair `EbbServer.Functions.children/1` starts in production when no
  `:bundle_dir` is configured. The parent router's delegation is covered by
  `EbbServer.Functions.RouterTest`.
  """

  use ExUnit.Case, async: false

  import EbbServer.FunctionsTestHelpers
  import EbbServer.TestHelpers, only: [create_isolated_tables: 0]
  import Plug.Conn

  alias EbbServer.Functions.{Protocol, Store}
  alias EbbServer.TestFunctions.{BlockingWorker, InputScriptedWorker, RecordingWorker}
  alias EbbServer.TestHelpers

  @actor "a_functions_store_router"
  @intruder "a_functions_store_intruder"
  @admin_token "deploy-secret"
  @code "export const echoStore = (params) => params;\n"

  setup context do
    tables = create_isolated_tables()
    store = start_store(TestHelpers.tmp_dir(context))
    cache = start_store_cache(store)

    %{tables: tables, table: tables.group_members, store: store, cache: cache}
  end

  defp router_opts(ctx, extra \\ []) do
    Keyword.merge(
      [
        store: ctx.store,
        cache: ctx.cache,
        group_members_table: ctx.table,
        admin_token: @admin_token,
        actor_id: @actor
      ],
      extra
    )
  end

  defp upload(ctx, name, envelope, code, opts) do
    body = upload_body(envelope, code)
    call_functions(:post, "/#{name}/versions", body, router_opts(ctx, opts))
  end

  defp activate(ctx, name, version, opts) do
    body = Jason.encode!(%{"version" => version})
    call_functions(:post, "/#{name}/activate", body, router_opts(ctx, opts))
  end

  defp invoke(ctx, name, body, opts \\ []) do
    call_functions(:post, "/#{name}", body, router_opts(ctx, opts))
  end

  defp deploy!(ctx, name, envelope_overrides, opts) do
    envelope = envelope_for(name, @code, envelope_overrides)

    assert upload(ctx, name, envelope, @code, opts).status == 201
    assert activate(ctx, name, "1.0.0", opts).status == 200
    :ok
  end

  defp admin(opts \\ []), do: Keyword.put(opts, :authorization, "Bearer " <> @admin_token)

  defp history(ctx, name, opts),
    do: call_functions(:get, "/#{name}/versions", "", router_opts(ctx, opts))

  defp rollback(ctx, name, opts),
    do: call_functions(:post, "/#{name}/rollback", "", router_opts(ctx, opts))

  defp disable(ctx, name, opts),
    do: call_functions(:post, "/#{name}/disable", "", router_opts(ctx, opts))

  describe "upload, activate, invoke" do
    test "the uploaded code is what the invocation runs", ctx do
      configure_boot(
        transport: RecordingWorker,
        worker_opts: [
          notify: self(),
          script: [
            %{"expect" => %{"type" => "invoke"}},
            %{"send" => Protocol.result({:ok, %{"ok" => true}})}
          ]
        ]
      )

      name = "echoStore"

      uploaded = upload(ctx, name, envelope_for(name, @code), @code, admin())
      assert uploaded.status == 201
      assert get_resp_header(uploaded, "content-type") == ["application/json; charset=utf-8"]

      assert %{
               "ok" => true,
               "name" => ^name,
               "version" => "1.0.0",
               "status" => "retired",
               "pinned" => false
             } = json_body(uploaded)

      activated = activate(ctx, name, "1.0.0", admin())
      assert activated.status == 200

      assert %{"ok" => true, "name" => ^name, "version" => "1.0.0", "status" => "active"} =
               json_body(activated)

      grant_function(ctx.tables, @actor, ["function." <> name])

      invoked = invoke(ctx, name, ~s({"text":"hi"}))
      assert invoked.status == 200
      assert json_body(invoked)["result"] == %{"ok" => true}
      assert json_body(invoked)["version"] == "1.0.0"
      assert get_resp_header(invoked, "x-ebb-function-version") == ["1.0.0"]

      assert_received {:functions_worker_sent,
                       %{"type" => "invoke", "bundle" => code, "version" => version}}

      assert code == @code
      assert version == "1.0.0"
    end

    test "a pinned upload reports its pin", ctx do
      name = "pinnedUpload"
      envelope = envelope_for(name, @code)

      body = Jason.encode!(%{"envelope" => envelope, "code" => @code, "pinned" => true})
      conn = call_functions(:post, "/#{name}/versions", body, router_opts(ctx, admin()))

      assert conn.status == 201
      assert json_body(conn)["pinned"] == true
    end
  end

  describe "version history, rollback, and disable" do
    test "history lists every version, newest first, without code", ctx do
      name = "history"
      v2_code = "export const history = () => ({ version: 2 });\n"
      v3_code = "export const history = () => ({ version: 3 });\n"

      assert upload(ctx, name, envelope_for(name, @code), @code, admin()).status == 201

      assert upload(
               ctx,
               name,
               envelope_for(name, v2_code, %{"version" => "2.0.0"}),
               v2_code,
               admin()
             ).status == 201

      assert upload(
               ctx,
               name,
               envelope_for(name, v3_code, %{"version" => "3.0.0"}),
               v3_code,
               admin()
             ).status == 201

      assert activate(ctx, name, "1.0.0", admin()).status == 200

      conn = history(ctx, name, admin())
      assert conn.status == 200
      assert %{"versions" => versions} = json_body(conn)
      assert Enum.map(versions, & &1["version"]) == ["3.0.0", "2.0.0", "1.0.0"]
      assert Enum.map(versions, & &1["status"]) == ["retired", "retired", "active"]
      assert Enum.all?(versions, &(not Map.has_key?(&1, "code")))
      assert Enum.all?(versions, &is_integer(&1["createdAt"]))
      assert Enum.all?(versions, &(&1["pinned"] == false))
    end

    test "history of an unknown name is 404, while a disabled name remains visible", ctx do
      assert history(ctx, "neverUploaded", admin()).status == 404

      name = "disabledHistory"
      deploy!(ctx, name, %{}, admin())
      assert disable(ctx, name, admin()).status == 200

      conn = history(ctx, name, admin())
      assert conn.status == 200
      assert [%{"version" => "1.0.0", "status" => "disabled"}] = json_body(conn)["versions"]
    end

    test "history, rollback, and disable require the admin credential and an actor", ctx do
      name = "guardedLifecycle"
      deploy!(ctx, name, %{}, admin())

      for call <- [
            fn opts -> history(ctx, name, opts) end,
            fn opts -> rollback(ctx, name, opts) end,
            fn opts -> disable(ctx, name, opts) end
          ] do
        assert call.([]).status == 403
        assert call.(authorization: "Bearer wrong").status == 403
        assert call.(admin(actor_id: nil)).status == 401
      end
    end

    test "rollback walks back through activations and then stops", ctx do
      name = "walkBack"
      v2_code = "export const walkBack = () => 2;\n"
      v3_code = "export const walkBack = () => 3;\n"

      assert upload(ctx, name, envelope_for(name, @code), @code, admin()).status == 201

      assert upload(
               ctx,
               name,
               envelope_for(name, v2_code, %{"version" => "2.0.0"}),
               v2_code,
               admin()
             ).status == 201

      assert upload(
               ctx,
               name,
               envelope_for(name, v3_code, %{"version" => "3.0.0"}),
               v3_code,
               admin()
             ).status == 201

      for version <- ~w(1.0.0 2.0.0 3.0.0) do
        assert activate(ctx, name, version, admin()).status == 200
      end

      first = rollback(ctx, name, admin())
      assert first.status == 200
      assert json_body(first)["version"] == "2.0.0"
      assert json_body(first)["status"] == "active"

      second = rollback(ctx, name, admin())
      assert second.status == 200
      assert json_body(second)["version"] == "1.0.0"

      third = rollback(ctx, name, admin())
      assert third.status == 409
      assert json_body(third)["error"] == "no_previous_version"
    end

    test "rollback with no active version is 404", ctx do
      name = "inactive"
      assert upload(ctx, name, envelope_for(name, @code), @code, admin()).status == 201

      conn = rollback(ctx, name, admin())
      assert conn.status == 404
      assert json_body(conn)["error"] == "not_found"
    end

    test "rollback refuses a pointer to a disabled version", ctx do
      name = "disabledRollback"
      v2_code = "export const disabledRollback = () => 2;\n"
      v3_code = "export const disabledRollback = () => 3;\n"

      assert upload(ctx, name, envelope_for(name, @code), @code, admin()).status == 201

      assert upload(
               ctx,
               name,
               envelope_for(name, v2_code, %{"version" => "2.0.0"}),
               v2_code,
               admin()
             ).status == 201

      assert upload(
               ctx,
               name,
               envelope_for(name, v3_code, %{"version" => "3.0.0"}),
               v3_code,
               admin()
             ).status == 201

      for version <- ~w(1.0.0 2.0.0 3.0.0) do
        assert activate(ctx, name, version, admin()).status == 200
      end

      assert rollback(ctx, name, admin()).status == 200
      assert disable(ctx, name, admin()).status == 200
      assert activate(ctx, name, "3.0.0", admin()).status == 200

      conn = rollback(ctx, name, admin())
      assert conn.status == 409
      assert json_body(conn)["error"] == "no_previous_version"
    end

    test "disable is the kill switch and a second disable is 404", ctx do
      configure_boot(transport: InputScriptedWorker)

      name = "routedKillSwitch"
      deploy!(ctx, name, %{}, admin())
      grant_function(ctx.tables, @actor, ["function.*"])

      assert invoke(ctx, name, "{}").status == 200

      disabled = disable(ctx, name, admin())
      assert disabled.status == 200
      assert json_body(disabled)["status"] == "disabled"

      missing = invoke(ctx, name, "{}")
      assert missing.status == 404
      assert json_body(missing)["error"] == "not_found"

      assert disable(ctx, name, admin()).status == 404

      assert activate(ctx, name, "1.0.0", admin()).status == 200
      assert invoke(ctx, name, "{}").status == 200
    end

    test "a store that cannot answer is a 500 on every lifecycle route", ctx do
      name = "storelessLifecycle"

      for call <- [
            fn -> history(ctx, name, admin(store: :functions_store_that_is_not_running)) end,
            fn -> rollback(ctx, name, admin(store: :functions_store_that_is_not_running)) end,
            fn -> disable(ctx, name, admin(store: :functions_store_that_is_not_running)) end
          ] do
        conn = call.()
        assert conn.status == 500
        assert json_body(conn)["error"] == "internal_error"
      end
    end
  end

  describe "admin authorization" do
    test "a missing, wrong, or malformed credential is 403 denied", ctx do
      name = "adminEcho"
      envelope = envelope_for(name, @code)

      for opts <- [
            [],
            [authorization: "Bearer wrong"],
            [authorization: "Basic " <> @admin_token],
            [authorization: "Bearer"]
          ] do
        conn = upload(ctx, name, envelope, @code, opts)

        assert conn.status == 403
        assert json_body(conn)["error"] == "denied"
      end

      # Nothing was stored by any of them.
      assert Store.list(ctx.store) == {:ok, []}
    end

    test "an unconfigured admin token denies rather than opens", ctx do
      name = "unconfiguredAdmin"
      envelope = envelope_for(name, @code)

      conn = upload(ctx, name, envelope, @code, authorization: "Bearer anything")

      assert conn.status == 403
      assert json_body(conn)["error"] == "denied"
    end

    test "a missing actor is 401 even with the admin credential", ctx do
      name = "actorlessAdmin"

      conn =
        upload(ctx, name, envelope_for(name, @code), @code, admin(actor_id: nil))

      assert conn.status == 401
      assert json_body(conn)["error"] == "unauthorized"
    end

    test "the admin credential never grants invoke permission", ctx do
      configure_boot(transport: InputScriptedWorker)

      name = "adminOnlyFunction"
      deploy!(ctx, name, %{}, admin())

      denied = invoke(ctx, name, "{}", admin())
      assert denied.status == 403
      assert json_body(denied)["error"] == "denied"

      grant_function(ctx.tables, @actor, ["function." <> name])

      allowed = invoke(ctx, name, "{}", admin())
      assert allowed.status == 200
      assert json_body(allowed)["result"] == %{"echo" => %{}}
    end
  end

  describe "GET /" do
    test "lists name, version, access, and schemas, and never code", ctx do
      params_schema = %{
        "type" => "object",
        "properties" => %{"text" => %{"type" => "string"}}
      }

      deploy!(ctx, "zetaFunction", %{"access" => "authenticated"}, admin())

      deploy!(
        ctx,
        "alphaFunction",
        %{"paramsSchema" => params_schema, "outputSchema" => %{"type" => "string"}},
        admin()
      )

      # Any resolved actor may list; the admin credential is not required and
      # does not change the answer.
      conn = call_functions(:get, "/", "", router_opts(ctx, actor_id: @intruder))

      assert conn.status == 200
      assert %{"functions" => [first, second]} = json_body(conn)

      assert first["name"] == "alphaFunction"
      assert first["version"] == "1.0.0"
      assert first["access"] == "granted"
      assert first["paramsSchema"] == params_schema
      assert first["outputSchema"] == %{"type" => "string"}
      refute Map.has_key?(first, "code")

      assert second["name"] == "zetaFunction"
      assert second["access"] == "authenticated"
      refute Map.has_key?(second, "paramsSchema")
      refute Map.has_key?(second, "outputSchema")
      refute Map.has_key?(second, "code")
    end

    test "requires a resolved actor", ctx do
      conn = call_functions(:get, "/", "", router_opts(ctx, actor_id: nil))

      assert conn.status == 401
      assert json_body(conn)["error"] == "unauthorized"
    end

    test "a store that cannot answer is a 500" do
      conn =
        call_functions(:get, "/", "",
          store: :functions_store_that_is_not_running,
          actor_id: @actor
        )

      assert conn.status == 500
      assert json_body(conn)["error"] == "internal_error"
    end
  end

  describe "activation" do
    test "a disabled function is 404 until it is activated again", ctx do
      configure_boot(transport: InputScriptedWorker)

      name = "killSwitch"
      deploy!(ctx, name, %{}, admin())
      grant_function(ctx.tables, @actor, ["function.*"])

      assert invoke(ctx, name, "{}").status == 200

      assert {:ok, disabled} = Store.disable(name, ctx.store)
      assert disabled.status == "disabled"

      missing = invoke(ctx, name, "{}")
      assert missing.status == 404
      assert json_body(missing)["error"] == "not_found"

      reactivated = activate(ctx, name, "1.0.0", admin())
      assert reactivated.status == 200
      assert json_body(reactivated)["status"] == "active"

      assert invoke(ctx, name, "{}").status == 200
    end

    test "an unknown version is 404 and changes nothing", ctx do
      deploy!(ctx, "knownFunction", %{}, admin())

      conn = activate(ctx, "knownFunction", "9.9.9", admin())

      assert conn.status == 404
      assert json_body(conn)["error"] == "not_found"
      assert {:ok, active} = Store.active("knownFunction", ctx.store)
      assert active.version == "1.0.0"
    end

    test "a missing or non-string version is 400 invalid_input", ctx do
      deploy!(ctx, "knownFunction", %{}, admin())

      for body <- [~s({}), ~s({"version":""}), ~s({"version":7})] do
        conn =
          call_functions(:post, "/knownFunction/activate", body, router_opts(ctx, admin()))

        assert conn.status == 400
        assert json_body(conn)["error"] == "invalid_input"
      end
    end
  end

  describe "upload refusals" do
    test "an envelope naming another function is refused", ctx do
      name = "namedFunction"
      body = upload_body(envelope_for("otherName", @code), @code)

      conn = call_functions(:post, "/#{name}/versions", body, router_opts(ctx, admin()))

      assert conn.status == 400
      assert %{"error" => "invalid_bundle", "details" => details} = json_body(conn)
      assert details =~ "does not match"
      refute details =~ "\n"
    end

    test "a digest that is not the code's is refused", ctx do
      name = "badDigest"
      envelope = envelope_for(name, @code, %{"digest" => "sha256:" <> String.duplicate("0", 64)})

      conn = upload(ctx, name, envelope, @code, admin())

      assert conn.status == 400
      assert json_body(conn)["error"] == "invalid_bundle"
      assert json_body(conn)["details"] == "bundle digest does not match its code"
    end

    test "an unresolvable schema is refused without leaking the resolver", ctx do
      name = "badSchema"
      envelope = envelope_for(name, @code, %{"paramsSchema" => %{"type" => "nonsense"}})

      conn = upload(ctx, name, envelope, @code, admin())

      assert conn.status == 400
      assert %{"error" => "invalid_bundle", "details" => details} = json_body(conn)
      assert details == "envelope paramsSchema is not a valid JSON Schema"
      refute details =~ "ExJsonSchema"
      refute details =~ "\n"
      assert Store.list(ctx.store) == {:ok, []}
    end

    test "an envelope that is not an object or a code that is not a string is refused", ctx do
      name = "shapeFunction"
      opts = router_opts(ctx, admin())

      not_an_object =
        call_functions(:post, "/#{name}/versions", ~s({"envelope":[],"code":"x"}), opts)

      assert not_an_object.status == 400
      assert json_body(not_an_object)["details"] =~ "envelope must be a JSON object"

      no_code =
        call_functions(
          :post,
          "/#{name}/versions",
          ~s({"envelope":{"name":"shapeFunction"},"code":""}),
          opts
        )

      assert no_code.status == 400
      assert json_body(no_code)["details"] =~ "code must be a non-empty string"
    end

    test "a re-upload of the same name and version is a 409", ctx do
      name = "duplicateFunction"
      envelope = envelope_for(name, @code)

      assert upload(ctx, name, envelope, @code, admin()).status == 201

      changed = "export const duplicateFunction = () => ({ changed: true });\n"
      changed_envelope = envelope_for(name, changed)
      duplicate = upload(ctx, name, changed_envelope, changed, admin())

      assert duplicate.status == 409
      assert %{"error" => "already_exists", "details" => details} = json_body(duplicate)
      assert details =~ "already exists"
      refute details =~ "\n"

      # The stored code is untouched.
      assert {:ok, %{code: stored}} = Store.get(name, "1.0.0", ctx.store)
      assert stored == @code
    end

    test "a body over the upload limit is 413", ctx do
      name = "hugeUpload"
      body = String.duplicate("a", 8 * 1024 * 1024 + 1)

      conn = call_functions(:post, "/#{name}/versions", body, router_opts(ctx, admin()))

      assert conn.status == 413
      assert json_body(conn)["error"] == "payload_too_large"
    end

    test "malformed JSON is 400 invalid_json", ctx do
      conn =
        call_functions(
          :post,
          "/wrongBody/versions",
          ~s({"envelope":),
          router_opts(ctx, admin())
        )

      assert conn.status == 400
      assert json_body(conn)["error"] == "invalid_json"
    end
  end

  describe "in-flight pinning" do
    test "an activation during an invocation does not change that invocation", ctx do
      configure_boot(transport: BlockingWorker, worker_opts: [notify: self()])

      name = "pinnedFunction"
      deploy!(ctx, name, %{}, admin())
      grant_function(ctx.tables, @actor, ["function.*"])

      opts = router_opts(ctx)
      first = Task.async(fn -> call_functions(:post, "/#{name}", "{}", opts) end)

      assert_receive {:functions_invoked, first_pid, first_frame}, 2_000
      assert first_frame["version"] == "1.0.0"

      second_envelope = envelope_for(name, @code, %{"version" => "2.0.0"})
      assert upload(ctx, name, second_envelope, @code, admin()).status == 201
      assert activate(ctx, name, "2.0.0", admin()).status == 200

      send(first_pid, {:functions_release, %{"from" => "first"}})

      first_conn = Task.await(first, 5_000)
      assert first_conn.status == 200
      assert json_body(first_conn)["version"] == "1.0.0"
      assert json_body(first_conn)["result"] == %{"from" => "first"}

      second = Task.async(fn -> call_functions(:post, "/#{name}", "{}", opts) end)
      assert_receive {:functions_invoked, second_pid, second_frame}, 2_000
      assert second_frame["version"] == "2.0.0"
      send(second_pid, {:functions_release, %{"from" => "second"}})

      second_conn = Task.await(second, 5_000)
      assert second_conn.status == 200
      assert json_body(second_conn)["version"] == "2.0.0"
    end
  end
end
