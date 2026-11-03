defmodule EbbServer.Functions.Worker.Bun do
  @moduledoc """
  A worker transport that runs one Bun process per invocation.

  The worker process owns everything the runner needs: a private temp
  directory, a Unix socket inside it, and a Port to the Bun process. The runner
  connects back to that socket, so frames travel over a stream the runner's
  stderr cannot corrupt and the host never has to multiplex stdio.

  The runner is started through `/usr/bin/env -i` with a scrubbed environment,
  and through a shell that makes itself the process-group leader before
  replacing itself with Bun, so `close/1` can end the runner together with
  whatever it spawned.

  `start/1` returns as soon as the socket is listening and the runner is
  spawned, before the runner has connected. Host frames sent in that window are
  queued in the worker process and written on connection, so an invocation can
  send its `invoke` immediately.
  """

  @behaviour EbbServer.Functions.Worker

  alias EbbServer.Functions.Protocol

  @default_accept_timeout_ms 5_000
  @default_spawn_timeout_ms 5_000
  @close_timeout_ms 1_000
  @accept_poll_ms 5
  @safe_path "/usr/local/bin:/usr/bin:/bin"
  @lang "C.UTF-8"

  @type handle :: %{
          pid: pid(),
          port: port(),
          dir: String.t(),
          socket_path: String.t()
        }

  @doc """
  Starts one runner for one invocation.

  Options:

    * `:owner` — required pid that receives `{:functions_worker_frame, frame}`
    * `:runner_path` — required path to the Bun entrypoint (`.ts` or `.js`)
    * `:socket_dir` — required parent directory for the worker's temp dir
    * `:bun_path` — Bun executable (default `System.find_executable("bun")`)
    * `:accept_timeout_ms` — how long the runner may take to connect (default 5000)
    * `:spawn_timeout_ms` — how long setup may take before `start/1` gives up (default 5000)
  """
  @impl true
  @spec start(keyword()) :: {:ok, handle()} | {:error, term()}
  def start(opts) do
    owner = Keyword.fetch!(opts, :owner)
    runner_path = Keyword.fetch!(opts, :runner_path)
    socket_dir = Keyword.fetch!(opts, :socket_dir)
    bun_path = Keyword.get_lazy(opts, :bun_path, fn -> System.find_executable("bun") end)
    accept_timeout = Keyword.get(opts, :accept_timeout_ms, @default_accept_timeout_ms)
    spawn_timeout = Keyword.get(opts, :spawn_timeout_ms, @default_spawn_timeout_ms)

    with :ok <- check_bun(bun_path),
         :ok <- check_runner(runner_path),
         {:ok, dir} <- make_dir(socket_dir) do
      socket_path = Path.join(dir, "s")
      parent = self()

      pid =
        spawn(fn ->
          run(%{
            owner: owner,
            parent: parent,
            runner_path: runner_path,
            bun_path: bun_path,
            dir: dir,
            socket_path: socket_path,
            accept_timeout_ms: accept_timeout
          })
        end)

      await_start(pid, dir, socket_path, spawn_timeout)
    end
  end

  defp await_start(pid, dir, socket_path, timeout) do
    case await_started(pid, timeout) do
      {:ok, port} ->
        {:ok, %{pid: pid, port: port, dir: dir, socket_path: socket_path}}

      {:error, reason} ->
        if Process.alive?(pid), do: Process.exit(pid, :kill)
        File.rm_rf(dir)
        {:error, reason}
    end
  end

  @impl true
  @spec send_frame(handle(), Protocol.frame()) :: :ok | {:error, term()}
  def send_frame(%{pid: pid}, frame) do
    if Process.alive?(pid) do
      with {:ok, data} <- encode(frame) do
        send(pid, {:functions_host_frame, data})
        :ok
      end
    else
      {:error, :closed}
    end
  end

  @doc """
  Ends the worker: the runner's process group, the port, and the temp dir.

  Idempotent, because it runs both on the invocation's normal path and as the
  cleanup for a worker that already stopped itself.
  """
  @impl true
  @spec close(handle()) :: :ok
  def close(%{pid: pid, port: port, dir: dir}) do
    # Read the OS pid while the port is still open: once it closes there is no
    # way back to the process group, and the runner may have outlived it.
    os_pid = port_os_pid(port)
    ref = Process.monitor(pid)
    send(pid, :functions_close)
    await_stopped(ref, pid)
    kill_group(os_pid)
    close_port(port)
    File.rm_rf(dir)
    :ok
  end

  @impl true
  @spec os_pid(handle()) :: non_neg_integer() | nil
  def os_pid(%{port: port}), do: port_os_pid(port)

  @impl true
  @spec alive?(handle()) :: boolean()
  def alive?(%{pid: pid}), do: Process.alive?(pid)

  @impl true
  @spec monitor(handle()) :: reference()
  def monitor(%{pid: pid}), do: Process.monitor(pid)

  @doc """
  The Unix socket the runner connects to. Exposed so a transport test can
  inspect the socket it created.
  """
  @spec socket_path(handle()) :: String.t()
  def socket_path(%{socket_path: socket_path}), do: socket_path

  defp check_bun(nil), do: {:error, :bun_not_found}

  defp check_bun(path) when is_binary(path) do
    if File.regular?(path), do: :ok, else: {:error, {:missing_executable, path}}
  end

  defp check_runner(path) when is_binary(path) do
    if File.regular?(path), do: :ok, else: {:error, {:missing_runner, path}}
  end

  defp check_runner(path), do: {:error, {:missing_runner, path}}

  defp make_dir(socket_dir) do
    unique = "#{System.unique_integer([:positive])}_#{System.os_time(:microsecond)}"
    dir = Path.join(socket_dir, "bun_#{unique}")

    with :ok <- File.mkdir_p(socket_dir),
         :ok <- File.mkdir(dir),
         :ok <- File.chmod(dir, 0o700) do
      {:ok, dir}
    end
  end

  defp await_started(pid, timeout) do
    ref = Process.monitor(pid)

    receive do
      {:functions_worker_started, ^pid, result} ->
        Process.demonitor(ref, [:flush])
        result

      {:DOWN, ^ref, :process, ^pid, reason} ->
        {:error, {:worker_exited, reason}}
    after
      timeout ->
        Process.demonitor(ref, [:flush])
        {:error, :spawn_timeout}
    end
  end

  defp encode(frame) do
    {:ok, Protocol.encode_frame(frame)}
  rescue
    error -> {:error, {:invalid_frame, Exception.message(error)}}
  end

  defp run(state) do
    Process.flag(:trap_exit, true)

    state =
      Map.merge(
        %{
          listener: nil,
          socket: nil,
          port: nil,
          queue: :queue.new(),
          buffer: <<>>,
          owner_ref: nil
        },
        state
      )

    case setup(state) do
      {:ok, listener, port} ->
        send(state.parent, {:functions_worker_started, self(), {:ok, port}})

        state = %{
          state
          | listener: listener,
            port: port,
            owner_ref: Process.monitor(state.owner)
        }

        await_connection(state, System.monotonic_time(:millisecond) + state.accept_timeout_ms)

      {:error, reason} ->
        send(state.parent, {:functions_worker_started, self(), {:error, reason}})
    end
  end

  defp setup(state) do
    case listen(state.socket_path) do
      {:ok, listener} ->
        with :ok <- File.chmod(state.socket_path, 0o600),
             {:ok, port} <- spawn_runner(state) do
          {:ok, listener, port}
        else
          {:error, reason} ->
            _ = :gen_tcp.close(listener)
            {:error, reason}
        end

      {:error, _reason} = error ->
        error
    end
  end

  defp listen(socket_path) do
    :gen_tcp.listen(0, [
      :binary,
      packet: :raw,
      active: false,
      ifaddr: {:local, socket_path},
      reuseaddr: true
    ])
  end

  defp spawn_runner(state) do
    env_path = System.find_executable("env") || "/usr/bin/env"
    args = env_args(state) ++ runner_command(state)

    {:ok,
     Port.open({:spawn_executable, env_path}, [
       :binary,
       :exit_status,
       # Frames travel over the Unix socket. Keeping stdio out of the port
       # means a handler's console.log cannot be mistaken for a frame.
       :nouse_stdio,
       {:cd, state.dir},
       {:args, args}
     ])}
  rescue
    error -> {:error, {:spawn_failed, Exception.message(error)}}
  end

  # The runner sees only what it needs to start and to find its own temp
  # directory. Anything inherited from the server — secrets, storage paths,
  # BEAM settings — stays out of its environment.
  defp env_args(state) do
    [
      "-i",
      "PATH=#{Path.dirname(state.bun_path)}:#{@safe_path}",
      "HOME=#{state.dir}",
      "TMPDIR=#{state.dir}",
      "LANG=#{@lang}"
    ]
  end

  # `set -m` makes the shell a process-group leader before `exec` replaces it
  # with Bun, so the Port's OS pid is also the group id. Without it the Port's
  # child stays in the BEAM's group and a group kill would take the server down
  # with the worker. Some shells warn that job control is unavailable without a
  # tty; the process-group change still happens, and the direct kill in
  # `kill_group/1` is the fallback when it does not.
  defp runner_command(state) do
    # `set -m` makes the shell a process-group leader, then `exec` replaces it.
    [
      System.find_executable("sh") || "/bin/sh",
      "-c",
      "set -m 2>/dev/null; exec \"$0\" \"$@\"",
      state.bun_path,
      state.runner_path,
      state.socket_path
    ]
  end

  defp await_connection(state, deadline) do
    case :gen_tcp.accept(state.listener, 0) do
      {:ok, socket} -> connected(state, socket)
      {:error, :timeout} -> await_connection_messages(state, deadline)
      {:error, reason} -> stop(state, reason)
    end
  end

  defp await_connection_messages(state, deadline) do
    remaining = deadline - System.monotonic_time(:millisecond)

    if remaining <= 0 do
      stop(state, :accept_timeout)
    else
      receive do
        {:functions_host_frame, data} ->
          await_connection(%{state | queue: :queue.in(data, state.queue)}, deadline)

        {:EXIT, port, reason} when port == state.port ->
          stop(state, reason)

        {:DOWN, ref, :process, _pid, reason} when ref == state.owner_ref ->
          stop(state, {:owner_down, reason})

        :functions_close ->
          stop(state, :normal)
      after
        min(remaining, @accept_poll_ms) -> await_connection(state, deadline)
      end
    end
  end

  defp connected(state, socket) do
    :inet.setopts(socket, active: :once)
    state = flush_queue(%{state | socket: socket})
    loop(state)
  end

  defp flush_queue(state) do
    case :queue.out(state.queue) do
      {:empty, _queue} ->
        state

      {{:value, data}, queue} ->
        case :gen_tcp.send(state.socket, data) do
          :ok -> flush_queue(%{state | queue: queue})
          {:error, reason} -> stop(%{state | queue: queue}, reason)
        end
    end
  end

  defp loop(state) do
    receive do
      {:functions_host_frame, data} ->
        case :gen_tcp.send(state.socket, data) do
          :ok -> loop(state)
          {:error, reason} -> stop(state, reason)
        end

      {:tcp, socket, data} when socket == state.socket ->
        handle_data(data, state)

      {:tcp_closed, socket} when socket == state.socket ->
        stop(state, :socket_closed)

      {:tcp_error, socket, reason} when socket == state.socket ->
        stop(state, reason)

      {:EXIT, port, reason} when port == state.port ->
        stop(state, reason)

      {:DOWN, ref, :process, _pid, reason} when ref == state.owner_ref ->
        stop(state, {:owner_down, reason})

      :functions_close ->
        stop(state, :normal)
    end
  end

  defp handle_data(data, state) do
    case Protocol.decode(state.buffer <> data) do
      {:ok, frames, buffer} ->
        Enum.each(frames, &send(state.owner, {:functions_worker_frame, &1}))

        case :inet.setopts(state.socket, active: :once) do
          :ok -> loop(%{state | buffer: buffer})
          {:error, reason} -> stop(%{state | buffer: buffer}, reason)
        end

      {:error, reason} ->
        stop(state, {:invalid_frame, reason})
    end
  end

  defp stop(state, reason) do
    close_socket(state.socket)
    close_listener(state.listener)
    kill_runner(state)
    File.rm_rf(state.dir)
    exit(reason)
  end

  defp close_socket(nil), do: :ok

  defp close_socket(socket) do
    _ = :gen_tcp.close(socket)
    :ok
  end

  defp close_listener(nil), do: :ok

  defp close_listener(listener) do
    _ = :gen_tcp.close(listener)
    :ok
  end

  defp kill_runner(%{port: nil}), do: :ok

  defp kill_runner(state) do
    kill_group(port_os_pid(state.port))
    close_port(state.port)
  end

  defp kill_group(nil), do: :ok

  defp kill_group(os_pid) do
    # The group kill handles anything the runner spawned; the direct kill is
    # the fallback for a shell that did not become the group leader.
    _ = System.cmd("kill", ["-9", "-#{os_pid}"], stderr_to_stdout: true)
    _ = System.cmd("kill", ["-9", "#{os_pid}"], stderr_to_stdout: true)
    :ok
  end

  defp await_stopped(ref, pid) do
    receive do
      {:DOWN, ^ref, :process, ^pid, _reason} -> :ok
    after
      @close_timeout_ms ->
        Process.exit(pid, :kill)

        receive do
          {:DOWN, ^ref, :process, ^pid, _reason} -> :ok
        after
          100 ->
            Process.demonitor(ref, [:flush])
            :ok
        end
    end
  end

  defp port_os_pid(nil), do: nil

  defp port_os_pid(port) do
    case Port.info(port, :os_pid) do
      {:os_pid, os_pid} -> os_pid
      nil -> nil
    end
  end

  defp close_port(nil), do: :ok

  defp close_port(port) do
    if Port.info(port) do
      try do
        Port.close(port)
      rescue
        ArgumentError -> :ok
      end
    end

    :ok
  end
end
