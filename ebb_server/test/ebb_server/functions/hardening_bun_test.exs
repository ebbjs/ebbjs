defmodule EbbServer.Functions.HardeningBunTest do
  @moduledoc """
  The duress cases from #597 that need a real Bun process.

  Timeouts and memory bombs are about what the OS does to a worker, not what
  the frame loop can simulate: the deadline closes the socket and kills the
  process group, and Linux applies the address-space cap before the handler
  allocates. These tests assert the invocation fails, the server keeps serving,
  and no worker directory is left behind.
  """

  use ExUnit.Case, async: false
  use EbbServer.Integration.StorageCase, with_auth_mode: true

  import ExUnit.CaptureLog
  import EbbServer.FunctionsTestHelpers

  alias EbbServer.Functions
  alias EbbServer.Functions.Worker.Bun, as: BunWorker
  alias EbbServer.Functions.Worker.Pool
  alias EbbServer.TestFunctions.Bundles

  alias EbbServer.TestFunctions.Bun, as: BunSupport

  @enabled_env "EBB_FUNCTIONS_ENABLED"
  @secret_env "EBB_TEST_BUN_SECRET"

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

  test "a CPU loop is killed at the deadline and the next invocation succeeds", %{dir: dir} do
    slow = "cpuLoop"
    after_slow = "afterCpuLoop"
    actor_id = unique("a")
    group_id = unique("g")

    seed_member(actor_id, group_id, ["function.*"])

    BunSupport.deploy_handler!(dir, slow, "async () => { while (true) {} }",
      envelope: %{"timeoutMs" => 150}
    )

    BunSupport.deploy_handler!(dir, after_slow, "async () => ({ ok: true })")
    configure_bun(dir)

    timed_out = post_function(slow, "{}", actor_id)

    assert timed_out.status == 408
    assert Jason.decode!(timed_out.resp_body)["retryable"] == true

    served = post_function(after_slow, "{}", actor_id)
    assert served.status == 200
    assert Jason.decode!(served.resp_body)["result"] == %{"ok" => true}

    # The worker directory (socket included) is removed on the kill path; a
    # leftover would be an orphaned process or a leaked socket.
    assert_eventually(fn -> File.ls(socket_dir(dir)) == {:ok, []} end)
  end

  test "declared secrets reach ctx.env as a frozen object", %{dir: dir} do
    name = "usesSecret"
    actor_id = unique("a")

    seed_member(actor_id, unique("g"), ["function.*"])
    System.put_env(@secret_env, "from-the-server")

    BunSupport.deploy_handler!(
      dir,
      name,
      "async (ctx) => ({ key: ctx.env[#{inspect(@secret_env)}], frozen: Object.isFrozen(ctx.env) })"
    )

    configure_bun(dir, env: %{name => [@secret_env]})
    Functions.resolve!()

    response = post_function(name, "{}", actor_id)

    assert response.status == 200

    assert Jason.decode!(response.resp_body)["result"] == %{
             "key" => "from-the-server",
             "frozen" => true
           }

    System.delete_env(@secret_env)
  end

  test "ctx.log and console become capped Logger lines", %{dir: dir} do
    name = "logsThroughBun"
    actor_id = unique("a")

    seed_member(actor_id, unique("g"), ["function.*"])

    BunSupport.deploy_handler!(
      dir,
      name,
      """
      async (ctx) => {
        ctx.log("hello from ctx.log", "warn");
        console.warn("hello from console");
        return { ok: true };
      }
      """
    )

    configure_bun(dir)

    {response, log} =
      with_captured_log(fn -> post_function(name, "{}", actor_id) end)

    assert response.status == 200
    assert log =~ "hello from ctx.log"
    assert log =~ "hello from console"
    assert log =~ "function_name=" <> name
  end

  test "the fetch allowlist blocks a host and is audited", %{dir: dir} do
    name = "fetches"
    actor_id = unique("a")

    seed_member(actor_id, unique("g"), ["function.*"])

    BunSupport.deploy_handler!(
      dir,
      name,
      """
      async () => {
        try {
          await fetch("http://127.0.0.1:1/blocked");
          return { blocked: false };
        } catch (error) {
          return { blocked: true, message: error.message };
        }
      }
      """
    )

    configure_bun(dir, fetch_allowlist: ["allowed.example.com"])

    parent = self()

    :telemetry.attach(
      "hardening-bun-fetch-audit",
      [:ebb, :functions, :fetch],
      fn _event, _measurements, metadata, _config -> send(parent, {:fetch_audit, metadata}) end,
      nil
    )

    on_exit(fn -> :telemetry.detach("hardening-bun-fetch-audit") end)

    response = post_function(name, "{}", actor_id)

    assert response.status == 200
    assert Jason.decode!(response.resp_body)["result"]["blocked"] == true
    assert_receive {:fetch_audit, %{blocked: true, url: "http://127.0.0.1:1/blocked"}}
  end

  test "the pool reuses a warm worker across invocations", %{dir: dir} do
    name = "pooledEcho"
    actor_id = unique("a")

    seed_member(actor_id, unique("g"), ["function.*"])
    BunSupport.deploy_handler!(dir, name, "async (ctx, params) => ({ echo: params })")

    start_pool(dir, size: 1)
    configure_bun(dir)

    first = post_function(name, ~s({"n":1}), actor_id)
    second = post_function(name, ~s({"n":2}), actor_id)

    assert first.status == 200
    assert second.status == 200
    assert Jason.decode!(second.resp_body)["result"] == %{"echo" => %{"n" => 2}}

    # One worker served both: no kill, no spawn failure, and it is idle again.
    assert %{idle: 1, workers: 1, kills: 0, spawn_failures: 0} = Pool.snapshot(Pool)
  end

  test "saturation is a 503 and the next invocation recovers", %{dir: dir} do
    slow = "poolSlow"
    after_slow = "poolAfterSlow"
    actor_id = unique("a")

    seed_member(actor_id, unique("g"), ["function.*"])

    BunSupport.deploy_handler!(dir, slow, "async () => { while (true) {} }",
      envelope: %{"timeoutMs" => 300}
    )

    BunSupport.deploy_handler!(dir, after_slow, "async () => ({ ok: true })")

    start_pool(dir, size: 1, queue_limit: 0)
    configure_bun(dir)

    task = Task.async(fn -> post_function(slow, "{}", actor_id) end)
    assert_eventually(fn -> Pool.snapshot(Pool).busy == 1 end)

    refused = post_function(after_slow, "{}", actor_id)

    assert refused.status == 503
    refused_body = Jason.decode!(refused.resp_body)
    assert refused_body["error"] == "saturated"
    assert refused_body["retryable"] == true

    assert Task.await(task).status == 408

    # The deadline killed that worker; the pool replaced it and serves again.
    assert_eventually(fn -> Pool.snapshot(Pool).idle == 1 end)
    served = post_function(after_slow, "{}", actor_id)
    assert served.status == 200
  end

  test "a memory bomb is contained and the next invocation succeeds", %{dir: dir} do
    bomb = "memoryBomb"
    after_bomb = "afterMemoryBomb"
    actor_id = unique("a")
    group_id = unique("g")

    seed_member(actor_id, group_id, ["function.*"])

    BunSupport.deploy_handler!(
      dir,
      bomb,
      "async () => { const held = []; while (true) held.push(Buffer.alloc(1024 * 1024)); }",
      envelope: %{"timeoutMs" => 5_000}
    )

    BunSupport.deploy_handler!(dir, after_bomb, "async () => ({ ok: true })")
    configure_bun(dir)

    response = post_function(bomb, "{}", actor_id)

    # The OS cap kills the process, or JSC raises the failed allocation and the
    # runner reports it as the handler's error; either way the invocation ends
    # with a version and an id instead of hanging or taking the request process
    # down.
    assert response.status in [422, 500, 503]
    body = Jason.decode!(response.resp_body)
    assert body["version"] == "1.0.0"
    assert is_binary(body["invocation_id"])
    assert body["error"] in ["handler_error", "runner_error", "unavailable", "protocol_error"]

    served = post_function(after_bomb, "{}", actor_id)
    assert served.status == 200

    assert_eventually(fn -> File.ls(socket_dir(dir)) == {:ok, []} end)
  end

  defp start_pool(dir, opts) do
    start_supervised!(
      {Pool,
       Keyword.merge(
         [
           name: Pool,
           size: 1,
           queue_limit: 0,
           queue_timeout_ms: 100,
           transport: BunWorker,
           transport_opts: BunSupport.transport_opts(dir)
         ],
         opts
       )}
    )

    assert_eventually(fn -> Pool.snapshot(Pool).idle == Keyword.get(opts, :size, 1) end)
  end

  defp socket_dir(dir), do: Path.join(dir, "sockets")

  defp with_captured_log(fun) do
    parent = self()
    ref = make_ref()

    log =
      capture_log(fn ->
        send(parent, {:captured_response, ref, fun.()})
      end)

    assert_received {:captured_response, ^ref, response}
    {response, log}
  end

  defp assert_eventually(fun, attempts \\ 100) do
    cond do
      fun.() ->
        :ok

      attempts > 0 ->
        Process.sleep(20)
        assert_eventually(fun, attempts - 1)

      true ->
        flunk("condition never became true")
    end
  end
end
