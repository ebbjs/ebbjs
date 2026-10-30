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

  import EbbServer.Integration.ActionHelpers
  import EbbServer.SSEHelpers, only: [data_payloads: 1]
  import EbbServer.TestHelpers, only: [generate_hlc: 0]
  import Plug.Conn
  import Plug.Test

  alias EbbServer.Functions.{Bundle, BundleCache, Protocol}
  alias EbbServer.Functions.Worker.Fake
  alias EbbServer.Sync.{GroupRegistry, Router}

  alias EbbServer.TestFunctions.{Bundles, InputScriptedWorker}

  @enabled_env "EBB_FUNCTIONS_ENABLED"
  @await_timeout_ms 5_000

  # Stands in for the socket the SSE handler writes to. The route's bytes are
  # forwarded to the test process, which is the only way to observe them
  # without a real connection.
  defmodule RecordingAdapter do
    @moduledoc false

    def send_chunked(%{test: test} = state, _status, _headers) do
      send(test, :chunked_started)
      {:ok, "", state}
    end

    def chunk(%{test: test} = state, body) do
      bytes = IO.iodata_to_binary(body)
      send(test, {:chunk_written, bytes})
      {:ok, bytes, state}
    end
  end

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
      assert event["id"] == action["id"]
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

      configure_boot(bundle_dir: dir, transport: InputScriptedWorker)

      timed_out = post_function(slow, ~s({"hang":true}), actor_id)

      assert timed_out.status == 408
      body = Jason.decode!(timed_out.resp_body)
      assert body["error"] == "timeout"
      assert body["retryable"] == true
      assert body["version"] == "1.0.0"

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

  defp unique(prefix), do: "#{prefix}_#{System.unique_integer([:positive])}"

  defp seed_member(actor_id, group_id, permissions) do
    assert bootstrap_group(actor_id, group_id, permissions).status == 200
  end

  defp fields(title) do
    hlc = generate_hlc()
    %{"title" => %{"type" => "lww", "value" => title, "hlc" => hlc}}
  end

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

  defp deploy!(dir, name, opts \\ []) do
    code =
      Keyword.get(opts, :code, "export const #{name} = () => ({ ok: true });")

    overrides =
      %{"digest" => Bundle.digest_for(code)}
      |> Map.merge(Keyword.get(opts, :envelope, %{}))

    Bundles.write_bundle!(dir, Bundles.envelope(name, overrides), code)
  end

  # The flag, the bundle directory, and the transport are node configuration,
  # so tests write them through the one nested key an operator uses and put
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

  # `Sync.Router` delegates to the route with no options, so it asks the
  # registered cache exactly as a booted node does.
  defp start_cache(dir) do
    start_supervised!({BundleCache, loader_opts: [dir: dir]})
  end

  defp post_function(name, body, actor_id) do
    conn(:post, "/functions/#{name}", body)
    |> put_req_header("content-type", "application/json")
    |> put_req_header("x-ebb-actor-id", actor_id)
    |> Router.call([])
  end

  # --- live subscriber -----------------------------------------------------

  defp start_live_stream(group_id, actor_id) do
    test_pid = self()

    conn =
      conn(:get, "/sync/live?groups=#{group_id}&cursor=0")
      |> put_req_header("x-ebb-actor-id", actor_id)
      |> Map.put(:adapter, {RecordingAdapter, %{test: test_pid}})

    task = Task.async(fn -> Router.call(conn, []) end)
    ref = Process.monitor(task.pid)

    receive do
      :chunked_started ->
        :ok

      {:DOWN, ^ref, :process, _pid, reason} ->
        flunk("the /sync/live route ended before opening a stream: #{inspect(reason)}")
    after
      @await_timeout_ms -> flunk("the /sync/live route never opened a stream")
    end

    Process.demonitor(ref, [:flush])
    await_subscriber(group_id)
    task
  end

  # The route registers its subscriber inside `open_sse/4` *after* switching
  # the response to chunked mode, so committing right after `:chunked_started`
  # could race the subscription. Waiting for the group's server to hold the
  # connection makes the delivery assertion about fan-out, not scheduling.
  defp await_subscriber(group_id) do
    await(
      fn ->
        case GroupRegistry.lookup(group_id) do
          nil -> nil
          pid -> if subscribed?(pid), do: pid
        end
      end,
      "the SSE subscriber for #{group_id}"
    )
  end

  defp subscribed?(pid) do
    case :sys.get_state(pid) do
      %{subscribers: subscribers} -> MapSet.size(subscribers) > 0
    end
  catch
    :exit, _reason -> false
  end

  defp await(
         fun,
         description,
         deadline \\ System.monotonic_time(:millisecond) + @await_timeout_ms
       ) do
    case fun.() do
      nil ->
        if System.monotonic_time(:millisecond) > deadline do
          flunk("timed out waiting for #{description}")
        else
          Process.sleep(10)
          await(fun, description, deadline)
        end

      found ->
        found
    end
  end

  # --- worker script -------------------------------------------------------

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
