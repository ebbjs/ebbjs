defmodule EbbServer.Functions.WorkerBunTest do
  use ExUnit.Case, async: true

  import Bitwise

  alias EbbServer.Functions.{Protocol, Worker}
  alias EbbServer.Functions.Worker.Bun

  @bun System.find_executable("bun")
  @frame_timeout 5_000

  @moduletag :bun
  @moduletag skip: if(is_nil(@bun), do: "bun is not installed", else: false)

  setup do
    dir = tmp_dir("ebb_bun_worker")
    ExUnit.Callbacks.on_exit(fn -> File.rm_rf(dir) end)
    %{dir: dir, socket_dir: Path.join(dir, "sockets")}
  end

  describe "a Bun worker" do
    test "carries frames over the socket, then close kills it and removes its dir", %{
      dir: dir,
      socket_dir: socket_dir
    } do
      runner = write_runner!(dir, "echo.ts", echo_runner())
      {:ok, worker} = start_worker(runner, socket_dir)

      # Sent before the runner connects: the transport must queue it.
      invoke = Protocol.invoke(%{"name" => "echo", "input" => %{"n" => 1}})
      assert :ok = Worker.send_frame(worker, invoke)

      assert_receive {:functions_worker_frame, %{"type" => "ready"} = ready}, @frame_timeout

      assert_receive {:functions_worker_frame,
                      %{"type" => "result", "ok" => true, "value" => %{"echoed" => %{"n" => 1}}}},
                     @frame_timeout

      socket_path = Bun.socket_path(worker.handle)
      assert %File.Stat{mode: mode} = File.stat!(socket_path)
      assert (mode &&& 0o777) == 0o600

      os_pid = Worker.os_pid(worker)
      assert os_pid == ready["pid"]
      assert Worker.alive?(worker)

      ref = Worker.monitor(worker)
      assert :ok = Worker.close(worker)
      assert_receive {:DOWN, ^ref, :process, _pid, :normal}, @frame_timeout

      refute Worker.alive?(worker)
      assert_os_process_gone(os_pid)
      refute File.exists?(worker.handle.dir)
      refute File.exists?(socket_path)

      assert :ok = Worker.close(worker)
    end

    test "a runner that exits without a result stops the worker", %{
      dir: dir,
      socket_dir: socket_dir
    } do
      runner = write_runner!(dir, "crash.ts", crashing_runner())
      {:ok, worker} = start_worker(runner, socket_dir)
      ref = Worker.monitor(worker)

      assert_receive {:functions_worker_frame, %{"type" => "ready"}}, @frame_timeout

      assert :ok = Worker.send_frame(worker, Protocol.invoke(%{"name" => "crash"}))

      assert_receive {:DOWN, ^ref, :process, _pid, reason}, @frame_timeout
      assert reason in [:socket_closed, {:exit_status, 7}]
      refute Worker.alive?(worker)
      refute_receive {:functions_worker_frame, %{"type" => "result"}}, 100

      assert :ok = Worker.close(worker)
      refute File.exists?(worker.handle.dir)
    end

    test "missing binaries are a start failure", %{dir: dir, socket_dir: socket_dir} do
      runner = write_runner!(dir, "echo.ts", echo_runner())

      assert {:error, {:missing_runner, _path}} =
               Bun.start(
                 owner: self(),
                 runner_path: Path.join(dir, "absent.ts"),
                 socket_dir: socket_dir
               )

      assert {:error, :bun_not_found} =
               Bun.start(
                 owner: self(),
                 runner_path: runner,
                 socket_dir: socket_dir,
                 bun_path: nil
               )
    end
  end

  defp start_worker(runner_path, socket_dir) do
    Worker.start(Bun,
      owner: self(),
      runner_path: runner_path,
      socket_dir: socket_dir,
      accept_timeout_ms: 3_000,
      spawn_timeout_ms: 3_000
    )
  end

  defp tmp_dir(prefix) do
    dir =
      Path.join(
        System.tmp_dir!(),
        "#{prefix}_#{System.unique_integer([:positive])}_#{System.os_time(:microsecond)}"
      )

    File.mkdir_p!(dir)
    dir
  end

  defp write_runner!(dir, name, source) do
    path = Path.join(dir, name)
    File.write!(path, source)
    path
  end

  defp assert_os_process_gone(os_pid) do
    if System.find_executable("kill") do
      assert wait_until(fn -> not os_process_alive?(os_pid) end),
             "runner process #{os_pid} is still alive after close/1"
    end
  end

  defp os_process_alive?(os_pid) do
    case System.cmd("kill", ["-0", Integer.to_string(os_pid)], stderr_to_stdout: true) do
      {_output, 0} -> true
      {_output, _status} -> false
    end
  end

  defp wait_until(fun, timeout_ms \\ 1_000) do
    deadline = System.monotonic_time(:millisecond) + timeout_ms
    do_wait_until(fun, deadline)
  end

  defp do_wait_until(fun, deadline) do
    cond do
      fun.() ->
        true

      System.monotonic_time(:millisecond) >= deadline ->
        false

      true ->
        Process.sleep(10)
        do_wait_until(fun, deadline)
    end
  end

  # The runner delays its `ready` so the invoke the test sends right after
  # `start/1` is provably queued before the connection exists. It writes its
  # result in two chunks so the host has to buffer a partial frame, and it
  # writes to stderr to show that channel cannot corrupt the frame stream.
  defp echo_runner do
    """
    import { connect } from "node:net";

    const socketPath = process.argv[2]!;

    const encode = (frame: unknown): Buffer => {
      const payload = Buffer.from(JSON.stringify(frame), "utf8");
      const header = Buffer.alloc(4);
      header.writeUInt32BE(payload.length, 0);
      return Buffer.concat([header, payload]);
    };

    const socket = connect({ path: socketPath });

    const send = (frame: unknown): void => {
      socket.write(encode(frame));
    };

    let buffer = Buffer.alloc(0);

    socket.on("connect", () => {
      process.stderr.write("bun worker connected\\n");
      setTimeout(() => {
        send({
          type: "ready",
          pid: process.pid,
          runner_version: "test",
          protocol_version: 1,
        });
      }, 100);
    });

    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);

      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0);
        if (buffer.length < 4 + length) return;

        const frame = JSON.parse(buffer.subarray(4, 4 + length).toString("utf8"));
        buffer = buffer.subarray(4 + length);

        if (frame.type === "invoke") {
          const encoded = encode({
            type: "result",
            ok: true,
            value: { echoed: frame.input },
          });
          const cut = Math.floor(encoded.length / 2);
          socket.write(encoded.subarray(0, cut));
          setTimeout(() => socket.write(encoded.subarray(cut)), 10);
        }
      }
    });
    """
  end

  defp crashing_runner do
    """
    import { connect } from "node:net";

    const socketPath = process.argv[2]!;

    const encode = (frame: unknown): Buffer => {
      const payload = Buffer.from(JSON.stringify(frame), "utf8");
      const header = Buffer.alloc(4);
      header.writeUInt32BE(payload.length, 0);
      return Buffer.concat([header, payload]);
    };

    const socket = connect({ path: socketPath });

    let buffer = Buffer.alloc(0);

    socket.on("connect", () => {
      socket.write(
        encode({
          type: "ready",
          pid: process.pid,
          runner_version: "test",
          protocol_version: 1,
        }),
      );
    });

    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);

      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0);
        if (buffer.length < 4 + length) return;

        const frame = JSON.parse(buffer.subarray(4, 4 + length).toString("utf8"));
        buffer = buffer.subarray(4 + length);

        if (frame.type === "invoke") {
          process.exit(7);
        }
      }
    });
    """
  end
end
