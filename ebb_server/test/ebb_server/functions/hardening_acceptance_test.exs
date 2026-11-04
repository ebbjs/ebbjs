defmodule EbbServer.Functions.HardeningAcceptanceTest do
  @moduledoc """
  The adversarial list from #597, exercised through the real router.

  Every request enters through `EbbServer.Sync.Router`, so `AuthPlug`, the
  boot flag, principal resolution, the access check, the secret map, the
  envelope, and the worker boundary are wired as a node runs them. The worker
  is the scripted fake unless the test is tagged `:bun`, so the suite proves
  the server's half without a Bun install.
  """

  use ExUnit.Case, async: false
  use EbbServer.Integration.StorageCase, with_auth_mode: true

  import ExUnit.CaptureLog
  import EbbServer.FunctionsTestHelpers
  import EbbServer.Integration.ActionHelpers
  import EbbServer.TestHelpers, only: [generate_hlc: 0]

  alias EbbServer.Functions
  alias EbbServer.Functions.{Protocol, Stats}
  alias EbbServer.Functions.Worker.Fake
  alias EbbServer.Storage.{ActionLog, WatermarkTracker}
  alias EbbServer.TestFunctions.{Bundles, InputScriptedWorker}

  @enabled_env "EBB_FUNCTIONS_ENABLED"
  @admin_env "EBB_FUNCTIONS_ADMIN_TOKEN"
  @secret_env "EBB_TEST_FUNCTIONS_SECRET"

  setup do
    previous_env = System.get_env(@enabled_env)
    System.delete_env(@enabled_env)

    on_exit(fn ->
      if previous_env, do: System.put_env(@enabled_env, previous_env)
    end)

    dir = Bundles.tmp_bundle_dir()
    cache = start_cache(dir)
    start_supervised!({Stats, []})

    %{dir: dir, cache: cache}
  end

  describe "request and result bounds" do
    test "an oversize request body is 413 before any worker exists", %{dir: dir} do
      name = "bigInput"
      actor_id = unique("a")

      seed_member(actor_id, unique("g"), ["function.*"])
      deploy!(dir, name)

      configure_boot(
        bundle_dir: dir,
        transport: InputScriptedWorker,
        worker_opts: [notify: self()]
      )

      body = ~s({"x":"#{String.duplicate("a", Functions.max_invoke_body_bytes())}"})
      response = post_function(name, body, actor_id)

      assert response.status == 413
      assert Jason.decode!(response.resp_body)["error"] == "payload_too_large"
      refute_receive :functions_worker_started, 200
    end

    test "an oversize result is 413 rather than a broken invocation", %{dir: dir} do
      name = "bigOutput"
      actor_id = unique("a")

      seed_member(actor_id, unique("g"), ["function.*"])
      deploy!(dir, name)

      configure_boot(
        bundle_dir: dir,
        transport: Fake,
        worker_opts: [
          script: [
            %{"send" => Protocol.ready(nil, "fake-1.0.0")},
            %{"script" => "big_output"}
          ],
          scripts: %{
            "big_output" => fn api ->
              api.expect.(%{"type" => "invoke"})

              api.send.(
                Protocol.result({:error, "output_too_large", "result exceeds the frame bound"})
              )
            end
          }
        ]
      )

      response = post_function(name, "{}", actor_id)

      assert response.status == 413
      body = Jason.decode!(response.resp_body)
      assert body["error"] == "payload_too_large"
      assert body["details"] =~ "frame bound"
      refute Map.has_key?(body, "retryable")
    end
  end

  describe "the host-call budget" do
    test "a call past the budget is 429 and ends the invocation", %{dir: dir} do
      name = "chatty"
      actor_id = unique("a")

      seed_member(actor_id, unique("g"), ["function.*"])
      deploy!(dir, name)

      configure_boot(
        bundle_dir: dir,
        transport: Fake,
        max_host_calls: 0,
        worker_opts: [
          script: [
            %{"send" => Protocol.ready(nil, "fake-1.0.0")},
            %{"script" => "one_call"}
          ],
          scripts: %{
            "one_call" => fn api ->
              api.expect.(%{"type" => "invoke"})
              api.send.(Protocol.call("call_1", "get", %{"id" => unique("todo")}))
            end
          }
        ]
      )

      response = post_function(name, "{}", actor_id)

      assert response.status == 429
      body = Jason.decode!(response.resp_body)
      assert body["error"] == "host_call_limit"
      assert body["retryable"] == true
    end
  end

  describe "logging" do
    test "a flood is capped and the invocation still answers", %{dir: dir} do
      name = "noisy"
      actor_id = unique("a")

      seed_member(actor_id, unique("g"), ["function.*"])
      deploy!(dir, name)

      configure_boot(
        bundle_dir: dir,
        transport: Fake,
        worker_opts: [
          script: [
            %{"send" => Protocol.ready(nil, "fake-1.0.0")},
            %{"script" => "flood"}
          ],
          scripts: %{
            "flood" => fn api ->
              api.expect.(%{"type" => "invoke"})

              Enum.each(1..400, fn line ->
                api.send.(%{"type" => "log", "level" => "warn", "message" => "line #{line}"})
              end)

              api.send.(Protocol.result({:ok, %{"logged" => true}}))
            end
          }
        ]
      )

      {response, log} = run_with_log(fn -> post_function(name, "{}", actor_id) end)

      assert response.status == 200
      assert Jason.decode!(response.resp_body)["result"] == %{"logged" => true}
      assert log =~ "log output truncated"
      assert length(String.split(log, "line ", trim: true)) <= 202
    end
  end

  describe "secrets" do
    test "a missing secret fails before the worker, and an available one reaches the frame",
         %{dir: dir} do
      name = "needsSecret"
      actor_id = unique("a")

      seed_member(actor_id, unique("g"), ["function.*"])
      deploy!(dir, name)

      System.delete_env(@secret_env)

      configure_boot(
        bundle_dir: dir,
        transport: Fake,
        env: %{name => [@secret_env]},
        worker_opts: [
          script: [
            %{"send" => Protocol.ready(nil, "fake-1.0.0")},
            %{"script" => "read_env"}
          ],
          scripts: %{
            "read_env" => fn api ->
              invoke = api.expect.(%{"type" => "invoke"})
              send(api.owner, {:invocation_env, invoke["env"]})
              api.send.(Protocol.result({:ok, %{"ok" => true}}))
            end
          }
        ]
      )

      Functions.resolve!()

      refused = post_function(name, "{}", actor_id)

      assert refused.status == 422
      body = Jason.decode!(refused.resp_body)
      assert body["error"] == "missing_secret"
      assert body["details"] =~ @secret_env
      refute_received {:invocation_env, _env}

      System.put_env(@secret_env, "s3cret")
      Functions.resolve!()

      {accepted, log} = run_with_log(fn -> post_function(name, "{}", actor_id) end)
      assert accepted.status == 200
      assert_receive {:invocation_env, %{@secret_env => "s3cret"}}

      # The value reaches the frame and nothing else: not the response, not a
      # log line, not a telemetry metadata field.
      refute accepted.resp_body =~ "s3cret"
      refute log =~ "s3cret"
    end
  end

  describe "cross-actor reads" do
    test "ctx.get sees nil for an entity the subject cannot read", %{dir: dir} do
      name = "peek"
      actor_id = unique("a")
      owner_id = unique("a")
      other_group = unique("g")
      entity_id = unique("todo_other")

      seed_member(actor_id, unique("g"), ["function." <> name])

      seed_member(owner_id, other_group, ["todo.create", "todo.update", "groupMember.create"])

      assert write_entity_in_group(owner_id, entity_id, "todo", other_group, fields("secret")).status ==
               200

      deploy!(dir, name)

      configure_boot(
        bundle_dir: dir,
        transport: Fake,
        worker_opts: [
          script: [
            %{"send" => Protocol.ready(nil, "fake-1.0.0")},
            %{"script" => "peek"}
          ],
          scripts: %{
            "peek" => fn api ->
              api.expect.(%{"type" => "invoke"})
              api.send.(Protocol.call("read", "get", %{"id" => entity_id}))
              reply = api.expect.(%{"type" => "reply", "call_id" => "read"})
              send(api.owner, {:peek_reply, reply})
              api.send.(Protocol.result({:ok, %{"ok" => true}}))
            end
          }
        ]
      )

      response = post_function(name, "{}", actor_id)

      assert response.status == 200
      assert_receive {:peek_reply, %{"ok" => true, "value" => nil}}
    end
  end

  describe "service principals" do
    test "two credentials with the same Idempotency-Key make two Actions", %{dir: dir} do
      name = "writeNote"
      group_id = unique("g")
      subject = "svc_actor_" <> unique("subject")

      seed_member(subject, group_id, ["todo.create", "todo.update", "todo.read"])

      deploy!(dir, name)

      configure_boot(
        bundle_dir: dir,
        transport: Fake,
        services: [
          service("svc_a", subject, ["function.*"]),
          service("svc_b", subject, ["function.*"])
        ],
        worker_opts: [
          script: [
            %{"send" => Protocol.ready(nil, "fake-1.0.0")},
            %{"script" => "commit"}
          ],
          scripts: %{
            "commit" => fn api ->
              api.expect.(%{"type" => "invoke"})
              action = note_action(unique("todo_svc"), group_id, unique("svc"))
              api.send.(Protocol.call("commit", "commit", action))
              api.expect.(%{"type" => "reply", "call_id" => "commit"})
              api.send.(Protocol.result({:ok, %{"ok" => true}}))
            end
          }
        ]
      )

      Functions.resolve!()

      before = WatermarkTracker.committed_watermark()
      key = unique("idem")

      first =
        post_function(name, "{}", "ignored", [
          {"x-ebb-service-token", "token-svc_a"},
          {"idempotency-key", key}
        ])

      second =
        post_function(name, "{}", "ignored", [
          {"x-ebb-service-token", "token-svc_b"},
          {"idempotency-key", key}
        ])

      assert first.status == 200
      assert second.status == 200
      assert WatermarkTracker.committed_watermark() == before + 2
      assert length(ActionLog.read(before + 1, before + 2)) == 2
    end

    test "an unknown service token is 403 with no worker", %{dir: dir} do
      name = "secure"
      subject = "svc_actor_" <> unique("subject")

      seed_member(subject, unique("g"), ["function.*"])
      deploy!(dir, name)

      configure_boot(
        bundle_dir: dir,
        transport: InputScriptedWorker,
        services: [service("svc_a", subject, ["function.*"])],
        worker_opts: [notify: self()]
      )

      Functions.resolve!()

      response =
        post_function(name, "{}", "ignored", [{"x-ebb-service-token", "not-the-token"}])

      assert response.status == 403
      assert Jason.decode!(response.resp_body)["error"] == "denied"
      refute_receive :functions_worker_started, 200
    end

    test "access: authenticated admits a service with no function grant", %{dir: dir} do
      name = "openly"
      subject = "svc_actor_" <> unique("subject")

      deploy!(dir, name, envelope: %{"access" => "authenticated"})

      configure_boot(
        bundle_dir: dir,
        transport: InputScriptedWorker,
        services: [service("svc_a", subject, [])]
      )

      Functions.resolve!()

      response = post_function(name, "{}", "ignored", [{"x-ebb-service-token", "token-svc_a"}])

      assert response.status == 200
    end

    test "a service token on a sync route leaves the caller anonymous" do
      configure_boot(services: [service("svc_a", "svc_actor", ["function.*"])])
      Functions.resolve!()

      response =
        Plug.Test.conn(:get, "/entities/anything")
        |> Plug.Conn.put_req_header("x-ebb-service-token", "token-svc_a")
        |> EbbServer.Sync.Router.call([])

      assert response.status == 401
    end
  end

  describe "the admin credential" do
    test "is supplied through the environment and never grants invoke", context do
      name = "deployMe"
      actor_id = unique("a")
      operator = unique("a")
      %{dir: dir, cache: cache} = context

      seed_member(actor_id, unique("g"), [])

      System.put_env(@admin_env, "env-admin-token")

      configure_boot(bundle_dir: dir, transport: InputScriptedWorker)
      Functions.resolve!()

      assert Functions.admin_token() == "env-admin-token"

      code = "export const deployMe = () => ({ ok: true });"

      store_dir = Path.join(System.tmp_dir!(), unique("store"))
      on_exit(fn -> File.rm_rf(store_dir) end)
      store = start_store(store_dir)

      upload =
        call_functions(
          :post,
          "/#{name}/versions",
          upload_body(envelope_for(name, code), code),
          actor_id: operator,
          authorization: "Bearer env-admin-token",
          store: store
        )

      assert upload.status in [200, 201]

      denied_admin =
        call_functions(
          :post,
          "/#{name}/versions",
          upload_body(envelope_for(name, code), code),
          actor_id: operator,
          authorization: "Bearer wrong",
          store: store
        )

      assert denied_admin.status == 403

      deploy!(dir, name)

      # The admin token deployed it; it still does not let its holder invoke.
      invoke =
        call_functions(:post, "/#{name}", "{}",
          actor_id: operator,
          authorization: "Bearer env-admin-token",
          cache: cache
        )

      assert invoke.status == 403
      assert Jason.decode!(invoke.resp_body)["error"] == "denied"
    end
  end

  describe "health" do
    test "reports per-version counters and pool gauges to the admin", %{dir: dir} do
      name = "counted"
      actor_id = unique("a")

      seed_member(actor_id, unique("g"), ["function.*"])
      deploy!(dir, name)

      configure_boot(
        bundle_dir: dir,
        transport: InputScriptedWorker,
        admin_token: "health-token"
      )

      assert post_function(name, "{}", actor_id).status == 200

      response =
        call_functions(:get, "/health", "",
          actor_id: actor_id,
          authorization: "Bearer health-token"
        )

      assert response.status == 200
      body = Jason.decode!(response.resp_body)
      [row] = Enum.filter(body["functions"], &(&1["name"] == name))
      assert row["invocations"] >= 1
      assert is_map(body["pool"])
      assert is_integer(body["pool"]["idle"])
    end
  end

  describe "health counters after failures" do
    test "count errors, timeouts, and worker kills per version", %{dir: dir} do
      fails = "alwaysFails"
      slow = "alwaysSlow"
      actor_id = unique("a")

      seed_member(actor_id, unique("g"), ["function.*"])
      deploy!(dir, fails)
      deploy!(dir, slow, envelope: %{"timeoutMs" => 50})

      configure_boot(
        bundle_dir: dir,
        transport: Fake,
        admin_token: "health-token",
        worker_opts: [
          script: [
            %{"send" => Protocol.ready(nil, "fake-1.0.0")},
            %{"script" => "branch"}
          ],
          scripts: %{
            "branch" => fn api ->
              invoke = api.expect.(%{"type" => "invoke"})

              case invoke["name"] do
                ^fails -> api.send.(Protocol.result({:error, "handler_error", "boom"}))
                ^slow -> :ok
              end
            end
          }
        ]
      )

      assert post_function(fails, "{}", actor_id).status == 422
      assert post_function(slow, "{}", actor_id).status == 408

      response =
        call_functions(:get, "/health", "",
          actor_id: actor_id,
          authorization: "Bearer health-token"
        )

      assert response.status == 200
      rows = Jason.decode!(response.resp_body)["functions"]

      failed = Enum.find(rows, &(&1["name"] == fails))
      assert failed["errors"] >= 1
      assert failed["worker_kills"] >= 1

      timed_out = Enum.find(rows, &(&1["name"] == slow))
      assert timed_out["errors"] >= 1
      assert timed_out["timeouts"] >= 1
    end
  end

  # --- helpers -------------------------------------------------------------

  defp deploy!(dir, name, opts \\ []) do
    code = Keyword.get(opts, :code, "export const #{name} = () => ({ ok: true });")

    overrides =
      %{"digest" => EbbServer.Functions.Bundle.digest_for(code)}
      |> Map.merge(Keyword.get(opts, :envelope, %{}))

    Bundles.write_bundle!(dir, Bundles.envelope(name, overrides), code)
  end

  defp note_action(entity_id, group_id, title) do
    hlc = generate_hlc()

    %{
      "id" => unique("act_svc"),
      "hlc" => hlc,
      "updates" => [
        %{
          "id" => unique("upd_svc"),
          "subject_id" => entity_id,
          "subject_type" => "todo",
          "method" => "put",
          "data" => %{"fields" => fields(title)}
        },
        entity_group_update(entity_id, group_id, hlc)
      ]
    }
  end

  defp service(id, subject_actor_id, permissions) do
    %{
      id: id,
      token_sha256: :crypto.hash(:sha256, "token-#{id}") |> Base.encode16(case: :lower),
      subject_actor_id: subject_actor_id,
      permissions: permissions
    }
  end

  defp run_with_log(fun) do
    parent = self()
    ref = make_ref()

    log =
      capture_log(fn ->
        result = fun.()
        send(parent, {:capture_result, ref, result})
      end)

    assert_received {:capture_result, ^ref, result}
    {result, log}
  end
end
