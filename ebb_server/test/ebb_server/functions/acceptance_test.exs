defmodule EbbServer.Functions.AcceptanceTest do
  @moduledoc """
  End-to-end acceptance for #680: the milestone's walking skeleton.

  Every request here enters through `EbbServer.Sync.Router`, so the boot-time
  flag, `AuthPlug`, the delegation to `Functions.Router`, the access check, the
  invocation loop, the host operations, and the real storage are wired exactly
  as a node runs them. The only double is the worker transport, which is the
  seam #593 replaces.

  The live-subscriber assertion runs the `GET /sync/live` route in its own
  process with a recording socket adapter, so the bytes asserted on are the
  bytes the route wrote.
  """

  use ExUnit.Case, async: false
  use EbbServer.Integration.StorageCase, with_auth_mode: true

  import EbbServer.FunctionsTestHelpers
  import EbbServer.Integration.ActionHelpers
  import EbbServer.LiveStreamHelpers, only: [start_live_stream: 2]
  import EbbServer.SSEHelpers, only: [data_payloads: 1]
  import EbbServer.TestHelpers, only: [generate_hlc: 0]
  import Plug.Conn

  alias EbbServer.Functions.{Bundle, BundleCache, Protocol}
  alias EbbServer.Functions.Worker.Fake
  alias EbbServer.Storage.{ActionLog, WatermarkTracker}

  alias EbbServer.TestFunctions.{Bundles, InputScriptedWorker, RecordingWorker}

  @enabled_env "EBB_FUNCTIONS_ENABLED"
  @await_timeout_ms 5_000

  setup do
    # The flag reads the environment before app config, so a value left in the
    # shell must not decide what these tests prove.
    previous_env = System.get_env(@enabled_env)
    System.delete_env(@enabled_env)

    on_exit(fn ->
      if previous_env, do: System.put_env(@enabled_env, previous_env)
    end)

    dir = Bundles.tmp_bundle_dir()
    cache = start_cache(dir)

    %{dir: dir, cache: cache}
  end

  describe "the milestone's walking skeleton" do
    test "an invocation reads, writes, and its commit reaches a live subscriber", %{dir: dir} do
      name = "createTodo"
      actor_id = unique("a")
      group_id = unique("g")

      seed_member(actor_id, group_id, [
        "todo.create",
        "todo.update",
        "todo.read",
        "function." <> name
      ])

      seeded_id = unique("todo_seed")
      seed_title = "the seeded title"

      assert write_entity_in_group(actor_id, seeded_id, "todo", group_id, fields(seed_title)).status ==
               200

      created_id = unique("todo_fn")
      created_title = "written by the function"
      action = create_todo_action(created_id, group_id, created_title)

      deploy!(dir, name, envelope: %{"timeoutMs" => 5_000})

      script = read_then_commit_script(seeded_id, action, %{"id" => created_id})

      configure_boot(
        bundle_dir: dir,
        transport: Fake,
        worker_opts: [
          script: [
            %{"send" => Protocol.ready(nil, "fake-1.0.0")},
            %{"script" => "read_then_commit"}
          ],
          scripts: %{"read_then_commit" => script}
        ]
      )

      # Subscribed before the invocation so the Action is live traffic, not a
      # replay the assertion could pass on without fan-out working.
      stream = start_live_stream(group_id, actor_id)

      response = post_function(name, "{}", actor_id)

      assert response.status == 200
      body = Jason.decode!(response.resp_body)
      assert body["ok"] == true
      assert body["result"] == %{"id" => created_id}
      assert body["replayed"] == false
      assert body["version"] == "1.0.0"
      assert "inv_" <> id_suffix = body["invocation_id"]
      assert byte_size(id_suffix) == 16
      assert id_suffix =~ ~r/\A[0-9a-z]{16}\z/
      assert get_resp_header(response, "x-ebb-invocation-id") == [body["invocation_id"]]
      assert get_resp_header(response, "x-ebb-function-version") == ["1.0.0"]

      # The read the function performed saw the seeded entity's own value.
      assert_receive {:functions_read_reply, reply}, @await_timeout_ms
      assert %{"ok" => true, "value" => view} = reply
      assert view["id"] == seeded_id
      assert view["data"]["fields"]["title"]["value"] == seed_title

      # The commit is durable and readable through the ordinary endpoint.
      read = get_entity(created_id, actor_id)
      assert read.status == 200
      entity = Jason.decode!(read.resp_body)
      assert entity["id"] == created_id
      assert entity["type"] == "todo"
      assert entity["data"]["fields"]["title"]["value"] == created_title

      # And it was observable live, through the same route a client uses.
      assert_receive {:chunk_written, bytes}, @await_timeout_ms
      assert [payload] = data_payloads(bytes)
      event = Jason.decode!(payload)

      # The server owns the Action id: the one the handler put in the frame is
      # replaced by the id derived from the invocation.
      assert event["id"] == action_id_for(body["invocation_id"])
      refute event["id"] == action["id"]
      assert Enum.any?(event["updates"], &(&1["subject_id"] == created_id))

      Task.shutdown(stream, :brutal_kill)
    end

    test "a denied caller is refused before any worker exists", %{dir: dir} do
      name = "secureNote"
      owner_id = unique("a")
      group_id = unique("g")
      intruder_id = unique("a")

      seed_member(owner_id, group_id, ["groupMember.create", "function." <> name])
      assert add_group_member(owner_id, group_id, intruder_id, ["todo.read"]).status == 200

      deploy!(dir, name)

      configure_boot(
        bundle_dir: dir,
        transport: InputScriptedWorker,
        worker_opts: [notify: self()]
      )

      # The bundle resolves; the refusal below is therefore the access check,
      # not an unknown function.
      assert {:ok, %Bundle{name: ^name, version: "1.0.0"}} = BundleCache.active(name)

      response = post_function(name, "{}", intruder_id)

      assert response.status == 403
      body = Jason.decode!(response.resp_body)
      assert body["error"] == "denied"
      assert body["version"] == "1.0.0"
      assert "inv_" <> _id = body["invocation_id"]
      refute_receive :functions_worker_started, 200
    end

    test "a timeout kills the invocation and the server keeps serving", %{dir: dir} do
      slow = "slowTask"
      after_timeout = "afterTimeout"
      actor_id = unique("a")
      group_id = unique("g")

      seed_member(actor_id, group_id, ["function.*"])

      deploy!(dir, slow, envelope: %{"timeoutMs" => 50})
      deploy!(dir, after_timeout)

      configure_boot(
        bundle_dir: dir,
        transport: RecordingWorker,
        worker_opts: [
          notify: self(),
          script: [%{"script" => "by_input"}],
          scripts: %{"by_input" => &echo_or_hang/1}
        ]
      )

      timed_out = post_function(slow, ~s({"hang":true}), actor_id)

      assert timed_out.status == 408
      body = Jason.decode!(timed_out.resp_body)
      assert body["error"] == "timeout"
      assert body["retryable"] == true
      assert body["version"] == "1.0.0"

      # The deadline tears the worker down; it does not merely stop waiting.
      assert_receive :functions_worker_closed, 500

      # Same router, same cache, same transport: the deadline took down one
      # invocation, not the endpoint.
      served = post_function(after_timeout, ~s({"after":"timeout"}), actor_id)

      assert served.status == 200
      assert Jason.decode!(served.resp_body)["result"] == %{"echo" => %{"after" => "timeout"}}
    end

    test "function.<name> and function.* both grant, and neither grants nothing", %{dir: dir} do
      name = "greetUser"
      owner_id = unique("a")
      group_id = unique("g")
      literal_id = unique("a")
      wildcard_id = unique("a")
      stranger_id = unique("a")

      seed_member(owner_id, group_id, ["groupMember.create"])

      assert add_group_member(owner_id, group_id, literal_id, [
               "function." <> name
             ]).status == 200

      assert add_group_member(owner_id, group_id, wildcard_id, ["function.*"]).status == 200
      assert add_group_member(owner_id, group_id, stranger_id, ["todo.read"]).status == 200

      deploy!(dir, name)
      configure_boot(bundle_dir: dir, transport: InputScriptedWorker)

      literal = post_function(name, "{}", literal_id)
      assert literal.status == 200
      assert Jason.decode!(literal.resp_body)["ok"] == true

      wildcard = post_function(name, "{}", wildcard_id)
      assert wildcard.status == 200
      assert Jason.decode!(wildcard.resp_body)["ok"] == true

      stranger = post_function(name, "{}", stranger_id)
      assert stranger.status == 403
      assert Jason.decode!(stranger.resp_body)["error"] == "denied"
    end

    test "with the flag off the route is absent rather than erroring", %{dir: dir} do
      configure_boot(enabled: false, bundle_dir: dir)

      response = post_function("anything", "{}", unique("a"))

      assert response.status == 404
      assert response.resp_body == ""
      assert get_resp_header(response, "x-ebb-invocation-id") == []
      refute response.resp_body =~ "functions"
    end

    test "a bundle replaced on disk is picked up without a restart", %{dir: dir, cache: cache_pid} do
      name = "changingNote"
      actor_id = unique("a")
      group_id = unique("g")

      seed_member(actor_id, group_id, ["function.*"])

      deploy!(dir, name)
      configure_boot(bundle_dir: dir, transport: InputScriptedWorker)

      first = post_function(name, "{}", actor_id)
      assert first.status == 200
      assert Jason.decode!(first.resp_body)["version"] == "1.0.0"

      # Same name, new version and code. `write_bundle!/4` recomputes the
      # digest, so the replacement is a legitimate deploy, not a tamper.
      new_code = "export const changingNote = () => ({ version: 2 });"
      deploy!(dir, name, code: new_code, envelope: %{"version" => "2.0.0"})

      second = post_function(name, "{}", actor_id)
      assert second.status == 200
      assert Jason.decode!(second.resp_body)["version"] == "2.0.0"

      assert Process.whereis(BundleCache) == cache_pid
    end

    test "a rejected commit is 422 rejected rather than handler_error", %{dir: dir} do
      name = "rejectNote"
      actor_id = unique("a")
      group_id = unique("g")
      owner_id = unique("a")
      other_group = unique("g")

      seed_member(actor_id, group_id, ["function." <> name])
      seed_member(owner_id, other_group, ["todo.create", "todo.update", "groupMember.create"])

      foreign_id = unique("todo_other")

      assert write_entity_in_group(owner_id, foreign_id, "todo", other_group, fields("not yours")).status ==
               200

      deploy!(dir, name)

      action = create_todo_action(foreign_id, other_group, "overwritten")

      configure_boot(
        bundle_dir: dir,
        transport: Fake,
        worker_opts: [
          script: [
            %{"send" => Protocol.ready(nil, "fake-1.0.0")},
            %{"script" => "commit_only"}
          ],
          scripts: %{"commit_only" => commit_only_script(action)}
        ]
      )

      response = post_function(name, "{}", actor_id)

      assert response.status == 422
      body = Jason.decode!(response.resp_body)
      assert body["error"] == "rejected"
      assert body["details"] =~ "not_authorized"
      assert body["version"] == "1.0.0"
      refute Map.has_key?(body, "retryable")
      refute Map.has_key?(body, "replayed")

      # The same `%{"id", "reason", "details"?}` maps `POST /sync/actions`
      # returns, so a client can read both the same way.
      derived_id = action_id_for(body["invocation_id"])
      assert [%{"id" => ^derived_id, "reason" => "not_authorized"} = rejection] = body["rejected"]
      assert Map.keys(rejection) -- ["details", "id", "reason"] == []

      assert_receive {:functions_commit_reply, %{"ok" => false}}, @await_timeout_ms

      # Nothing was written: the foreign entity still holds its own title.
      read = get_entity(foreign_id, owner_id)
      assert read.status == 200
      assert Jason.decode!(read.resp_body)["data"]["fields"]["title"]["value"] == "not yours"
    end

    test "a retry with the same Idempotency-Key replays and drops the new writes", %{dir: dir} do
      name = "idempotentWrite"
      actor_id = unique("a")
      group_id = unique("g")
      key = unique("idem")

      seed_member(actor_id, group_id, [
        "function." <> name,
        "todo.create",
        "todo.update",
        "todo.read"
      ])

      deploy!(dir, name)

      configure_boot(
        bundle_dir: dir,
        transport: Fake,
        worker_opts: [
          script: [
            %{"send" => Protocol.ready(nil, "fake-1.0.0")},
            %{"script" => "commit_title"}
          ],
          scripts: %{"commit_title" => fn api -> commit_title(api, group_id) end}
        ]
      )

      before = WatermarkTracker.committed_watermark()

      first = post_function(name, ~s({"title":"first"}), actor_id, [{"idempotency-key", key}])
      assert first.status == 200
      first_body = Jason.decode!(first.resp_body)
      assert first_body["replayed"] == false

      assert_receive {:functions_committed, %{"replayed" => false}, first_entity},
                     @await_timeout_ms

      # The retry says the same thing as far as the server is concerned — same
      # key, same action id — but its handler produces different writes.
      second = post_function(name, ~s({"title":"second"}), actor_id, [{"idempotency-key", key}])
      assert second.status == 200
      second_body = Jason.decode!(second.resp_body)
      assert second_body["replayed"] == true
      assert second_body["invocation_id"] == first_body["invocation_id"]

      assert_receive {:functions_committed, %{"replayed" => true}, second_entity},
                     @await_timeout_ms

      # Exactly one Action, exactly one GSN, and one entity.
      assert WatermarkTracker.committed_watermark() == before + 1
      assert [_only] = ActionLog.read(before + 1, before + 1)

      assert action_id_for(first_body["invocation_id"]) ==
               action_id_for(second_body["invocation_id"])

      first_read = get_entity(first_entity, actor_id)
      assert first_read.status == 200
      assert Jason.decode!(first_read.resp_body)["data"]["fields"]["title"]["value"] == "first"
      assert get_entity(second_entity, actor_id).status == 404
    end

    test "a handler that throws after a read leaves the Action log empty", %{dir: dir} do
      name = "throwsAfterRead"
      actor_id = unique("a")
      group_id = unique("g")
      seeded_id = unique("todo_seed")

      seed_member(actor_id, group_id, ["function." <> name, "todo.read"])

      assert write_entity_in_group(actor_id, seeded_id, "todo", group_id, fields("seeded")).status ==
               200

      deploy!(dir, name)

      configure_boot(
        bundle_dir: dir,
        transport: Fake,
        worker_opts: [
          script: [
            %{"send" => Protocol.ready(nil, "fake-1.0.0")},
            %{"script" => "read_then_throw"}
          ],
          scripts: %{
            "read_then_throw" => fn api ->
              api.expect.(%{"type" => "invoke"})
              api.send.(Protocol.call("call_read", "get", %{"id" => seeded_id}))
              api.expect.(%{"type" => "reply", "call_id" => "call_read"})
              api.send.(Protocol.result({:error, "handler_error", "boom"}))
            end
          }
        ]
      )

      before = WatermarkTracker.committed_watermark()
      response = post_function(name, "{}", actor_id)

      assert response.status == 422
      body = Jason.decode!(response.resp_body)
      assert body["error"] == "handler_error"
      assert body["details"] == "boom"

      # Throwing before the commit frame is sent submits nothing at all.
      assert WatermarkTracker.committed_watermark() == before
      assert ActionLog.read(before + 1, before + 10) == []
    end

    test "a digest mismatch is refused rather than served", %{dir: dir} do
      name = "tamperedNote"
      actor_id = unique("a")
      group_id = unique("g")

      seed_member(actor_id, group_id, ["function.*"])

      # Code and envelope travel together but do not agree: the digest names
      # different bytes, so nothing may run.
      Bundles.write_bundle!(
        dir,
        Bundles.envelope(name, %{"digest" => Bundle.digest_for("a different bundle")}),
        "export const tamperedNote = () => 1;"
      )

      configure_boot(
        bundle_dir: dir,
        transport: InputScriptedWorker,
        worker_opts: [notify: self()]
      )

      response = post_function(name, "{}", actor_id)

      refute response.status == 200
      assert response.status == 500
      body = Jason.decode!(response.resp_body)
      assert body["error"] == "internal_error"
      assert "inv_" <> _id = body["invocation_id"]
      refute_receive :functions_worker_started, 200
    end
  end

  # --- setup helpers -------------------------------------------------------

  # One Action, one entity plus its group membership row: the smallest write a
  # function can commit, and enough for fan-out to reach the group.
  defp create_todo_action(entity_id, group_id, title) do
    hlc = generate_hlc()

    %{
      "id" => unique("act_fn"),
      "hlc" => hlc,
      "updates" => [
        %{
          "id" => unique("upd_fn"),
          "subject_id" => entity_id,
          "subject_type" => "todo",
          "method" => "put",
          "data" => %{"fields" => fields(title)}
        },
        entity_group_update(entity_id, group_id, hlc)
      ]
    }
  end

  # The handler builds an Action whose entity id is fresh per invocation, so a
  # retry that is not deduped would visibly create a second entity.
  defp commit_title(api, group_id) do
    invoke = api.expect.(%{"type" => "invoke"})
    entity_id = unique("todo_fn")
    action = create_todo_action(entity_id, group_id, invoke["input"]["title"])

    api.send.(Protocol.call("call_commit", "commit", action))

    %{"ok" => true, "value" => reply_value} =
      api.expect.(%{"type" => "reply", "call_id" => "call_commit"})

    send(api.owner, {:functions_committed, reply_value, entity_id})
    api.send.(Protocol.result({:ok, %{"id" => entity_id}}))
  end

  defp commit_only_script(action) do
    fn api ->
      api.expect.(%{"type" => "invoke"})
      api.send.(Protocol.call("call_commit", "commit", action))
      reply = api.expect.(%{"type" => "reply", "call_id" => "call_commit"})
      send(api.owner, {:functions_commit_reply, reply})
    end
  end

  defp deploy!(dir, name, opts \\ []) do
    code =
      Keyword.get(opts, :code, "export const #{name} = () => ({ ok: true });")

    overrides =
      %{"digest" => Bundle.digest_for(code)}
      |> Map.merge(Keyword.get(opts, :envelope, %{}))

    Bundles.write_bundle!(dir, Bundles.envelope(name, overrides), code)
  end

  # --- worker script -------------------------------------------------------

  # One transport answers two functions differently: `hang` idles until the
  # invocation deadline closes it, anything else echoes its input.
  defp echo_or_hang(api) do
    invoke = api.expect.(%{"type" => "invoke"})

    case invoke["input"] do
      %{"hang" => true} -> :ok
      input -> api.send.(Protocol.result({:ok, %{"echo" => input}}))
    end
  end

  # The fake's function-script escape hatch: the scenario needs the reply to
  # the read delivered back to the test, which a data-only step list cannot do.
  defp read_then_commit_script(read_id, action, result) do
    fn api ->
      api.expect.(%{"type" => "invoke"})
      api.send.(Protocol.call("call_read", "get", %{"id" => read_id}))
      reply = api.expect.(%{"type" => "reply", "call_id" => "call_read"})
      send(api.owner, {:functions_read_reply, reply})

      api.send.(Protocol.call("call_commit", "commit", action))
      api.expect.(%{"type" => "reply", "call_id" => "call_commit"})
      api.send.(Protocol.result({:ok, result}))
    end
  end
end
