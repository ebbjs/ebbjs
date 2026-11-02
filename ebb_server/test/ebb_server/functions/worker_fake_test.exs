defmodule EbbServer.Functions.WorkerFakeTest do
  use ExUnit.Case, async: true

  alias EbbServer.Functions.{Protocol, Worker}
  alias EbbServer.Functions.Worker.Fake
  alias EbbServer.TestFunctions.{ClosedWorker, FailingWorker}

  describe "the fake worker" do
    test "sends scripted frames and waits for expected ones" do
      ready = Protocol.ready(4242, "0.0.0")
      result = Protocol.result({:ok, %{"ok" => true}})

      script = [
        %{"send" => ready},
        %{"expect" => %{"type" => "invoke", "name" => "proofreadDocument"}},
        %{"send" => result}
      ]

      {:ok, worker} = Worker.start(Fake, script: script, owner: self())
      ref = Worker.monitor(worker)
      assert is_reference(ref)
      assert_receive {:functions_worker_frame, ^ready}

      assert Worker.alive?(worker)
      assert Worker.os_pid(worker) == nil

      invoke = Protocol.invoke(%{"name" => "proofreadDocument", "input" => %{}})
      assert :ok = Worker.send_frame(worker, invoke)
      assert_receive {:functions_worker_frame, ^result}

      assert :ok = Worker.close(worker)
      assert_receive {:DOWN, ^ref, :process, _pid, :normal}
      refute Worker.alive?(worker)
    end

    test "partial matching ignores extra received fields, including nested ones" do
      result = Protocol.result({:ok, %{"ok" => true}})

      script = [
        %{"expect" => %{"type" => "reply", "call_id" => "2", "value" => %{"id" => "e_fast"}}},
        %{"expect" => %{"type" => "reply", "call_id" => "1", "value" => %{"id" => "e_slow"}}},
        %{"send" => result}
      ]

      {:ok, worker} = Worker.start(Fake, script: script, owner: self())

      slow = Protocol.reply("1", {:ok, %{"id" => "e_slow", "type" => "doc"}})
      fast = Protocol.reply("2", {:ok, %{"id" => "e_fast", "type" => "doc"}})

      assert :ok = Worker.send_frame(worker, slow)
      assert :ok = Worker.send_frame(worker, fast)
      assert_receive {:functions_worker_frame, ^result}

      Worker.close(worker)
    end

    test "partial matching walks lists element by element" do
      result = Protocol.result({:ok, nil})

      script = [
        %{"expect" => %{"type" => "call", "updates" => [%{"id" => "u1"}]}},
        %{"send" => result}
      ]

      {:ok, worker} = Worker.start(Fake, script: script, owner: self())

      call = %{
        "type" => "call",
        "call_id" => "1",
        "op" => "commit",
        "updates" => [%{"id" => "u1", "subject_id" => "e_doc"}]
      }

      assert :ok = Worker.send_frame(worker, call)
      assert_receive {:functions_worker_frame, ^result}

      Worker.close(worker)
    end

    test "the function script escape hatch owns the rest of the scenario" do
      scripts = %{
        "overlapping" => fn api ->
          api.send.(Protocol.call("1", "get", %{"id" => "e_slow"}))
          api.send.(Protocol.call("2", "get", %{"id" => "e_fast"}))

          second = api.expect.(%{"type" => "reply", "call_id" => "2"})
          first = api.expect.(%{"type" => "reply", "call_id" => "1"})
          send(api.owner, {:script_replies, first, second})
        end
      }

      {:ok, worker} =
        Worker.start(Fake,
          script: [%{"script" => "overlapping"}],
          scripts: scripts,
          owner: self()
        )

      assert_receive {:functions_worker_frame, %{"type" => "call", "call_id" => "1"}}
      assert_receive {:functions_worker_frame, %{"type" => "call", "call_id" => "2"}}

      fast = Protocol.reply("2", {:ok, nil})
      slow = Protocol.reply("1", {:ok, nil})
      assert :ok = Worker.send_frame(worker, fast)
      assert :ok = Worker.send_frame(worker, slow)

      assert_receive {:script_replies, ^slow, ^fast}
      Worker.close(worker)
    end

    test "an exit step dies without a result" do
      script = [%{"send" => Protocol.ready(1, "0.0.0")}, %{"exit" => "now"}]
      ref = start_gated(script)

      assert_receive {:functions_worker_frame, %{"type" => "ready"}}
      assert_receive {:DOWN, ^ref, :process, _pid, :worker_exit}
    end

    test "a malformed step fails the fake" do
      ref = start_gated([%{"nonsense" => true}])

      assert_receive {:DOWN, ^ref, :process, _pid, {:invalid_step, %{"nonsense" => true}}}
    end

    test "an unknown function script fails the fake" do
      ref = start_gated([%{"script" => "missing"}])

      assert_receive {:DOWN, ^ref, :process, _pid, {:unknown_script, "missing"}}
    end

    test "expecting a frame that never arrives times out" do
      # A deadline that ends the fake bounds how long the test has to attach a
      # monitor, so it is set well above a scheduler hand-off and the assertion
      # below waits longer still. The bound is not a proof: this is the one test
      # whose exit the test cannot gate.
      {:ok, worker} =
        Worker.start(Fake,
          script: [%{"expect" => %{"type" => "invoke"}}],
          owner: self(),
          expect_timeout: 200
        )

      ref = Worker.monitor(worker)
      assert is_reference(ref)

      assert_receive {:DOWN, ^ref, :process, _pid, {:expect_timeout, %{"type" => "invoke"}}},
                     1_000
    end

    test "close ends a fake that is waiting for a frame" do
      {:ok, worker} =
        Worker.start(Fake, script: [%{"expect" => %{"type" => "invoke"}}], owner: self())

      ref = Worker.monitor(worker)
      assert :ok = Worker.close(worker)
      assert_receive {:DOWN, ^ref, :process, _pid, :normal}
    end

    test "frames after the script are dropped" do
      ready = Protocol.ready(1, "0.0.0")
      {:ok, worker} = Worker.start(Fake, script: [%{"send" => ready}], owner: self())

      assert_receive {:functions_worker_frame, ^ready}
      assert :ok = Worker.send_frame(worker, Protocol.result({:ok, nil}))
      assert Worker.alive?(worker)

      Worker.close(worker)
    end

    test "sending to a closed fake reports that it is closed" do
      {:ok, worker} = Worker.start(Fake, script: [], owner: self())
      ref = Worker.monitor(worker)
      assert :ok = Worker.close(worker)
      assert_receive {:DOWN, ^ref, :process, _pid, :normal}

      assert {:error, :closed} = Worker.send_frame(worker, Protocol.result({:ok, nil}))
      assert :ok = Worker.close(worker)
    end
  end

  describe "the worker wrapper" do
    test "returns a start failure" do
      assert {:error, :no_worker} = Worker.start(FailingWorker)
    end

    test "delegates to a transport that cannot be monitored" do
      assert {:ok, worker} = Worker.start(ClosedWorker)
      assert Worker.monitor(worker) == nil
      assert Worker.os_pid(worker) == nil
      assert Worker.alive?(worker)
      assert {:error, :closed} = Worker.send_frame(worker, Protocol.result({:ok, nil}))
      assert :ok = Worker.close(worker)
    end
  end

  # The fake runs its script in its own process, so a step that ends it can do
  # so before the test has a monitor to observe it — and a monitor attached to
  # an already dead process reports `:noproc` instead of the real reason. Gating
  # the script behind a frame the test sends only after monitoring makes the
  # attachment provable, so a `:DOWN` reason is the one the script exits with.
  defp start_gated(script) do
    gate = %{"expect" => %{"type" => "invoke"}}
    {:ok, worker} = Worker.start(Fake, script: [gate | script], owner: self())

    ref = Worker.monitor(worker)
    assert :ok = Worker.send_frame(worker, Protocol.invoke(%{"name" => "gated"}))

    ref
  end
end
