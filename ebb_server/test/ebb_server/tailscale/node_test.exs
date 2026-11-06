defmodule EbbServer.Tailscale.NodeTest do
  @moduledoc """
  Drives `EbbServer.Tailscale.Node` against a scripted stand-in for the Go
  gateway: a shell script that reads the configuration line, emits NDJSON the
  way `ebb_tsnode` does, and then blocks on stdin until the BEAM closes it.

  The fixture proves the child-process contract from this side: what arrives on
  stdin, how each event is logged, and that a dead gateway is replaced. No test
  needs a tailnet, the environment, or the real binary.
  """

  use ExUnit.Case, async: false

  import ExUnit.CaptureIO
  import ExUnit.CaptureLog

  alias EbbServer.Tailscale.Node

  @secret "test-proxy-secret"
  @tag_owners ~S("tagOwners": { "tag:ebb": ["autogroup:admin"] })

  setup do
    original_level = Logger.level()
    Logger.configure(level: :info)

    dir = Path.join(System.tmp_dir!(), "ebb_ts_node_#{System.unique_integer([:positive])}")
    File.mkdir_p!(dir)

    on_exit(fn ->
      Logger.configure(level: original_level)
      File.rm_rf(dir)
    end)

    %{dir: dir}
  end

  describe "the stdin contract" do
    test "writes the resolved configuration, secret, and backend address", %{dir: dir} do
      lines = [event(running(tags: ["tag:ebb"]))]
      pid = start_node!(dir, lines, tags: ["tag:ebb"])

      wait_for_status(pid)

      assert dir |> stdin_path() |> File.read!() |> Jason.decode!() == %{
               "state_dir" => Path.join(dir, "state"),
               "hostname" => "ebb",
               "auth_key" => "",
               "control_url" => "",
               "tags" => ["tag:ebb"],
               "https" => "auto",
               "backend_addr" => "127.0.0.1:4000",
               "proxy_secret" => @secret,
               "qr" => true
             }
    end

    test "runs the gateway in the configured working directory", %{dir: dir} do
      cwd = Path.join(dir, "cwd")
      File.mkdir_p!(cwd)

      pid =
        start_node!(dir, [event(running(tags: ["tag:ebb"]))],
          tags: ["tag:ebb"],
          spawn_opts: [{:cd, cwd}]
        )

      wait_for_status(pid)

      assert dir |> Path.join("pwd") |> File.read!() |> String.trim() |> Path.basename() ==
               Path.basename(cwd)
    end
  end

  describe "login" do
    test "logs each distinct URL once", %{dir: dir} do
      lines = [
        event(%{"event" => "login", "url" => "https://login.example/first"}),
        event(%{"event" => "login", "url" => "https://login.example/first"}),
        event(%{"event" => "login", "url" => "https://login.example/second"}),
        event(running(tags: ["tag:ebb"]))
      ]

      log =
        capture_log(fn ->
          pid = start_node!(dir, lines, tags: ["tag:ebb"])
          wait_for_status(pid)

          assert Node.last_login_url(pid) == "https://login.example/second"
        end)

      assert length(Regex.scan(~r/login required: https:\/\/login\.example\/first/, log)) == 1
      assert log =~ "tailscale login required: https://login.example/second"
    end

    test "prints the QR lines raw, once per URL", %{dir: dir} do
      lines = [
        event(%{
          "event" => "qr",
          "url" => "https://login.example/first",
          "lines" => ["██▀▀▀", "██▄▄▄"]
        }),
        event(%{
          "event" => "qr",
          "url" => "https://login.example/first",
          "lines" => ["██▀▀▀", "██▄▄▄"]
        }),
        event(running(tags: ["tag:ebb"]))
      ]

      output =
        capture_io(fn ->
          pid = start_node!(dir, lines, tags: ["tag:ebb"])
          wait_for_status(pid)
          GenServer.stop(pid)
        end)

      assert output == "██▀▀▀\n██▄▄▄\n"
    end

    test "suppresses the QR when it is disabled", %{dir: dir} do
      lines = [
        event(%{"event" => "qr", "url" => "https://login.example/first", "lines" => ["██▀▀▀"]}),
        event(running(tags: ["tag:ebb"]))
      ]

      output =
        capture_io(fn ->
          pid = start_node!(dir, lines, tags: ["tag:ebb"], qr: false)
          wait_for_status(pid)
          GenServer.stop(pid)
        end)

      assert output == ""
    end
  end

  describe "running" do
    test "stores and logs the serving status", %{dir: dir} do
      status = running(tags: ["tag:ebb"], ips: ["100.64.0.1", "fd7a::1"], tls: true)

      log =
        capture_log(fn ->
          pid = start_node!(dir, [event(status)], tags: ["tag:ebb"])

          assert wait_for_status(pid) == status
        end)

      assert log =~
               "tailscale node is serving https://ebb.example.ts.net " <>
                 "(ips: 100.64.0.1,fd7a::1, tls: on, tags: tag:ebb)"
    end

    test "warns about an untagged node with its expiry date", %{dir: dir} do
      status = running(tags: [], tls: false, key_expiry: "2027-01-02T03:04:05Z")

      log =
        capture_log(fn ->
          pid = start_node!(dir, [event(status)])
          wait_for_status(pid)
        end)

      assert log =~ "tailscale node is untagged"
      assert log =~ "its key expires on 2027-01-02T03:04:05Z"
      assert log =~ @tag_owners
    end

    test "reports an unknown expiry when the node has none", %{dir: dir} do
      status = running(tags: []) |> Map.delete("key_expiry") |> Map.delete("tags")

      log =
        capture_log(fn ->
          pid = start_node!(dir, [event(status)])
          wait_for_status(pid)
        end)

      assert log =~ "key expiry unknown"
    end

    test "warns when the key expires within two weeks", %{dir: dir} do
      expiry =
        DateTime.utc_now() |> DateTime.add(3 * 86_400, :second) |> DateTime.to_iso8601()

      log =
        capture_log(fn ->
          pid =
            start_node!(dir, [event(running(tags: ["tag:ebb"], key_expiry: expiry))],
              tags: ["tag:ebb"]
            )

          wait_for_status(pid)
        end)

      assert log =~ "key expires on #{expiry}, within 14 days"
    end

    test "stays quiet about a key that expires later", %{dir: dir} do
      expiry = "2099-01-02T03:04:05Z"

      log =
        capture_log(fn ->
          pid =
            start_node!(dir, [event(running(tags: ["tag:ebb"], key_expiry: expiry))],
              tags: ["tag:ebb"]
            )

          wait_for_status(pid)
        end)

      refute log =~ "key expires on"
    end

    test "warns when requested tags were not applied", %{dir: dir} do
      status = running(tags: []) |> Map.delete("key_expiry")

      log =
        capture_log(fn ->
          pid = start_node!(dir, [event(status)], tags: ["tag:ebb"])
          wait_for_status(pid)
        end)

      assert log =~ "did not apply the requested tags [\"tag:ebb\"] (applied: [])"
      assert log =~ @tag_owners
      assert log =~ "re-authenticate the node"
      refute log =~ "EBB_TAILSCALE_REQUIRE_TAGS"
    end

    test "warns for the tags that were not applied when some were", %{dir: dir} do
      status = running(tags: ["tag:ebb"]) |> Map.delete("key_expiry")

      log =
        capture_log(fn ->
          pid = start_node!(dir, [event(status)], tags: ["tag:ebb", "tag:other"])
          wait_for_status(pid)
        end)

      assert log =~ ~s(did not apply the requested tags ["tag:other"])
      assert log =~ ~s(\"tag:other\": [\"autogroup:admin\"])
    end

    test "stops instead of serving when the tags are required", %{dir: dir} do
      status = running(tags: []) |> Map.delete("key_expiry")
      test_pid = self()

      log =
        capture_log(fn ->
          pid = start_node!(dir, [event(status)], tags: ["tag:ebb"], require_tags: true)
          ref = Process.monitor(pid)
          send(test_pid, :monitoring)

          assert_receive {:DOWN, ^ref, :process, ^pid, :normal}, 5_000
        end)

      assert log =~ "[error]"
      assert log =~ "EBB_TAILSCALE_REQUIRE_TAGS is set, so the gateway is stopping"
    end
  end

  describe "the gateway transcript" do
    @tag :gateway_contract
    test "parses every event shape on the wire", %{dir: dir} do
      lines = transcript()
      assert Enum.map(lines, &Jason.decode!(&1)["event"]) == ~w(login qr running error)

      log =
        capture_log(fn ->
          output =
            capture_io(fn ->
              pid = start_node!(dir, lines, tags: ["tag:ebb"])
              status = wait_for_status(pid)

              assert status["dns_name"] == "ebb.example.ts.net"
              assert status["ips"] == ["100.64.0.1", "fd7a:115c:a1e0::1"]
              assert status["tags"] == ["tag:ebb"]
              assert status["key_expiry"] == "2027-01-02T03:04:05Z"
              assert Node.last_login_url(pid) == "https://login.tailscale.com/a/abc123"
            end)

          assert output == "██▀▀▀\n██▄▄▄\n"
        end)

      assert log =~ "tailscale node is serving https://ebb.example.ts.net"
      assert log =~ "ebb_tsnode: control server unreachable"
    end
  end

  describe "gateway output" do
    test "logs an error event", %{dir: dir} do
      lines = [
        event(%{"event" => "error", "message" => "control unreachable"}),
        event(running(tags: ["tag:ebb"]))
      ]

      log =
        capture_log(fn ->
          pid = start_node!(dir, lines, tags: ["tag:ebb"])
          wait_for_status(pid)
        end)

      assert log =~ "ebb_tsnode: control unreachable"
    end

    test "forwards a non-JSON line such as a Go stderr log", %{dir: dir} do
      lines = [
        "2026/01/01 tsnet: dial tcp: connection refused",
        "ebb_tsnode: already prefixed",
        event(running(tags: ["tag:ebb"]))
      ]

      log =
        capture_log(fn ->
          pid = start_node!(dir, lines, tags: ["tag:ebb"])
          wait_for_status(pid)
        end)

      assert log =~ "ebb_tsnode: 2026/01/01 tsnet: dial tcp: connection refused"
      assert log =~ "ebb_tsnode: already prefixed"
      refute log =~ "ebb_tsnode: ebb_tsnode:"
    end

    test "survives a line longer than the port's line limit", %{dir: dir} do
      overlong = [
        {:raw, "head -c 1100000 /dev/zero | tr '\\0' 'a'"},
        {:raw, "echo"}
      ]

      log =
        capture_log(fn ->
          pid =
            start_node!(dir, overlong ++ [event(running(tags: ["tag:ebb"]))], tags: ["tag:ebb"])

          wait_for_status(pid)
        end)

      assert log =~ "tailscale node is serving"
      # The overlong line is forwarded as a fragment rather than stored, which
      # is how the dropped chunk shows up: the log carries its tail.
      assert log =~ "ebb_tsnode: aaa"
    end
  end

  describe "start-up contract" do
    test "refuses to start without the resolved config" do
      assert_raise ArgumentError, ~r/:config/, fn -> Node.start_link([]) end
    end

    test "is a transient child that outwaits the drain" do
      spec = Node.child_spec(config: %{proxy_bin: "/nonexistent"})

      # `:transient` keeps an intentional stop from being restarted, and
      # `shutdown` has to exceed the drain so the supervisor does not kill the
      # node before it kills the gateway.
      assert spec.restart == :transient
      assert spec.shutdown == 8_000
    end
  end

  describe "lifecycle" do
    test "reopens the gateway after it exits", %{dir: dir} do
      lines = [event(%{"event" => "error", "message" => "boom"})]

      log =
        capture_log(fn ->
          pid =
            start_node!(dir, lines,
              exit_status: 3,
              backoff_initial_ms: 10,
              backoff_max_ms: 10
            )

          wait_until(fn -> length(read_pids(dir)) >= 2 end)
          GenServer.stop(pid)
        end)

      assert log =~ "ebb_tsnode exited with status 3"
      assert log =~ "ebb_tsnode restarting in 10ms (attempt 1)"

      # A fresh OS process means a fresh port, so the replacement really is a
      # new child rather than the dead one being reused.
      pids = read_pids(dir)
      assert length(Enum.uniq(pids)) >= 2
    end

    test "names the process so operators can query it", %{dir: dir} do
      pid =
        start_node!(dir, [event(running(tags: ["tag:ebb"]))],
          tags: ["tag:ebb"],
          name: :ebb_tsnode_test
        )

      wait_for_status(pid)

      assert Process.whereis(:ebb_tsnode_test) == pid
      assert Node.status(:ebb_tsnode_test)["tags"] == ["tag:ebb"]
    end

    test "ignores a message that is not from the port it owns", %{dir: dir} do
      pid = start_node!(dir, [event(running(tags: ["tag:ebb"]))], tags: ["tag:ebb"])
      wait_for_status(pid)
      port = :sys.get_state(pid).port

      send(pid, {make_ref(), {:exit_status, 0}})
      send(pid, {make_ref(), {:data, {:eol, "late"}}})
      Process.sleep(50)

      assert :sys.get_state(pid).port == port
      assert :sys.get_state(pid).attempts == 0
    end

    test "stops instead of restarting after a fatal exit", %{dir: dir} do
      log =
        capture_log(fn ->
          pid =
            start_node!(dir, [],
              exit_status: Node.fatal_exit_status(),
              backoff_initial_ms: 10,
              backoff_max_ms: 10
            )

          ref = Process.monitor(pid)

          assert_receive {:DOWN, ^ref, :process, ^pid, :normal}, 5_000
        end)

      assert log =~ "ebb_tsnode exited with status #{Node.fatal_exit_status()} (fatal"
      refute log =~ "restarting in"
    end

    test "stops cleanly while it waits to restart", %{dir: dir} do
      pid = start_node!(dir, [], exit_status: 0, backoff_initial_ms: 60_000)

      # The fixture exits once it has the configuration, so until the backoff
      # elapses the node owns no port and stopping it must not raise.
      wait_until(fn -> :sys.get_state(pid).port == nil end)

      assert GenServer.stop(pid) == :ok
    end

    test "drains the gateway when a supervisor shuts it down", %{dir: dir} do
      bin = write_fixture!(dir, [event(running(tags: ["tag:ebb"]))], nil, false)

      spec =
        Supervisor.child_spec(
          {Node, config: config_for(dir, bin, tags: ["tag:ebb"])},
          id: :drain
        )

      {:ok, sup} = Supervisor.start_link([spec], strategy: :one_for_one)
      on_exit(fn -> if Process.alive?(sup), do: Supervisor.stop(sup) end)
      [{:drain, pid, _, _}] = Supervisor.which_children(sup)
      wait_for_status(pid)
      [os_pid | _rest] = read_pids(dir)

      assert Supervisor.stop(sup) == :ok
      assert File.read!(drained_path(dir)) == "drained"
      refute os_process_alive?(os_pid)
    end

    test "kills a gateway that ignores the closed stdin", %{dir: dir} do
      # This fixture never reads stdin, so closing the port cannot make it exit;
      # terminate/2 has to escalate once the drain timeout passes.
      pid =
        start_node!(dir, [event(running(tags: ["tag:ebb"]))],
          stubborn: true,
          shutdown_timeout_ms: 100,
          tags: ["tag:ebb"]
        )

      wait_for_status(pid)
      [os_pid | _rest] = read_pids(dir)

      GenServer.stop(pid)

      wait_until(fn -> not os_process_alive?(os_pid) end)
      refute os_process_alive?(os_pid)
    end
  end

  # The same file the Go suite asserts its emitter against, so the fixture stops
  # being our own idea of the protocol.
  defp transcript do
    "../../../tsnode/testdata/events.ndjson"
    |> Path.expand(__DIR__)
    |> File.read!()
    |> String.split("\n", trim: true)
  end

  defp config_for(dir, bin, opts) do
    %{
      node: :embedded,
      state_dir: Path.join(dir, "state"),
      hostname: "ebb",
      auth_key: nil,
      control_url: nil,
      tags: Keyword.get(opts, :tags, []),
      require_tags: Keyword.get(opts, :require_tags, false),
      https: "auto",
      qr: Keyword.get(opts, :qr, true),
      proxy_bin: bin,
      backend_addr: "127.0.0.1:4000",
      proxy_secret: @secret
    }
  end

  defp running(opts) do
    %{
      "event" => "running",
      "url" => "https://ebb.example.ts.net",
      "dns_name" => "ebb.example.ts.net",
      "ips" => Keyword.get(opts, :ips, ["100.64.0.1"]),
      "tls" => Keyword.get(opts, :tls, true),
      "tags" => Keyword.get(opts, :tags, [])
    }
    |> maybe_put("key_expiry", Keyword.get(opts, :key_expiry))
  end

  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)

  defp event(map), do: Jason.encode!(map)

  defp start_node!(dir, lines, opts \\ []) do
    bin =
      write_fixture!(
        dir,
        lines,
        Keyword.get(opts, :exit_status),
        Keyword.get(opts, :stubborn, false)
      )

    config = config_for(dir, bin, opts)
    backoff = Keyword.get(opts, :backoff_initial_ms, 60_000)

    {:ok, pid} =
      Node.start_link(
        config: config,
        name: Keyword.get(opts, :name, nil),
        backoff_initial_ms: backoff,
        backoff_max_ms: Keyword.get(opts, :backoff_max_ms, 60_000),
        shutdown_timeout_ms: Keyword.get(opts, :shutdown_timeout_ms, 5_000),
        spawn_opts: Keyword.get(opts, :spawn_opts, [])
      )

    on_exit(fn -> stop_node(pid) end)

    pid
  end

  # The node traps exits now, so the test process exiting stops it with
  # `:shutdown`; this cleanup races that and must not fail the test.
  defp stop_node(pid) do
    if Process.alive?(pid) do
      GenServer.stop(pid)
    end
  catch
    :exit, _reason -> :ok
  end

  # A stand-in for `ebb_tsnode`: one config line in, scripted NDJSON out, then
  # it blocks on stdin the way the real gateway does until the port closes.
  defp write_fixture!(dir, lines, exit_status, stubborn) do
    path = Path.join(dir, "ebb_tsnode")

    script =
      [
        "#!/usr/bin/env bash",
        "IFS= read -r config_line",
        "printf '%s' \"$config_line\" > #{shell_quote(stdin_path(dir))}",
        "echo \"$$\" >> #{shell_quote(pids_path(dir))}",
        "pwd > #{shell_quote(Path.join(dir, "pwd"))}",
        Enum.map(lines, fn
          {:raw, command} -> command
          line -> "printf '%s\\n' #{shell_quote(line)}"
        end),
        cond do
          exit_status ->
            "exit #{exit_status}"

          stubborn ->
            "exec sleep 60"

          true ->
            # The pause makes "drained" evidence that the BEAM waited for the
            # exit, rather than a file the orphan happened to write in time.
            "cat > /dev/null\nsleep 0.1\nprintf 'drained' > #{shell_quote(drained_path(dir))}"
        end
      ]
      |> List.flatten()
      |> Enum.join("\n")

    File.write!(path, script <> "\n")
    File.chmod!(path, 0o755)
    path
  end

  defp shell_quote(value), do: "'" <> String.replace(value, "'", ~S('\'')) <> "'"

  defp stdin_path(dir), do: Path.join(dir, "stdin.json")

  defp drained_path(dir), do: Path.join(dir, "drained")

  defp pids_path(dir), do: Path.join(dir, "pids")

  defp read_pids(dir) do
    case File.read(pids_path(dir)) do
      {:ok, contents} -> contents |> String.split("\n", trim: true)
      {:error, :enoent} -> []
    end
  end

  defp wait_for_status(pid) do
    wait_until(fn -> Node.status(pid) != nil end)
    Node.status(pid)
  end

  defp wait_until(fun, timeout_ms \\ 5_000) do
    do_wait_until(fun, System.monotonic_time(:millisecond) + timeout_ms)
  end

  defp do_wait_until(fun, deadline) do
    cond do
      fun.() ->
        :ok

      System.monotonic_time(:millisecond) > deadline ->
        flunk("timed out waiting for the gateway")

      true ->
        Process.sleep(10)
        do_wait_until(fun, deadline)
    end
  end

  defp os_process_alive?(os_pid) do
    match?({_output, 0}, System.cmd("sh", ["-c", "kill -0 #{os_pid} 2>/dev/null"]))
  end
end
