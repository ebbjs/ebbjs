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

  import EbbServer.FunctionsTestHelpers

  alias EbbServer.TestFunctions.Bundles

  alias EbbServer.TestFunctions.Bun, as: BunSupport

  @enabled_env "EBB_FUNCTIONS_ENABLED"

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

  defp socket_dir(dir), do: Path.join(dir, "sockets")

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
