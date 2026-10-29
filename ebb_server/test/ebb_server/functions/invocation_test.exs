defmodule EbbServer.Functions.InvocationTest do
  use ExUnit.Case, async: false
  use EbbServer.Integration.StorageCase, with_auth_mode: true

  import EbbServer.Integration.ActionHelpers
  import EbbServer.TestHelpers
  import ExUnit.CaptureLog

  alias EbbServer.Functions.{Invocation, Protocol}
  alias EbbServer.Storage.{ActionLog, WatermarkTracker}
  alias EbbServer.TestFunctions

  alias EbbServer.TestFunctions.{
    BadHost,
    ClosedWorker,
    DelayedHost,
    FailingWorker,
    NoMonitorWorker,
    RaisingHost,
    RecordingWorker
  }

  setup do
    bootstrap_group("a_test", "g_test", ["doc.create", "doc.update", "doc.read"])
    bootstrap_group("a_other", "g_other", ["doc.create", "doc.update", "doc.read"])

    write_entity_in_group("a_test", "e_doc", "doc", "g_test", fields())
    write_entity_in_group("a_other", "e_other", "doc", "g_other", fields())

    :ok
  end

  describe "a scripted invocation" do
    test "reads, commits, and answers every call with its own call_id" do
      before = WatermarkTracker.committed_watermark()

      assert {:ok, %{"ok" => true}} = run_fixture("get-then-commit")

      assert WatermarkTracker.committed_watermark() == before + 1
      assert [stored] = ActionLog.read(before + 1, before + 1)
      assert stored["actor_id"] == "a_test"

      replies = replies_by_call_id(sent_frames())
      assert replies["1"]["ok"] == true
      assert replies["1"]["value"]["id"] == "e_doc"
      assert replies["2"]["ok"] == true
      assert replies["2"]["value"] == nil
    end

    test "a handler that throws returns 422 and commits nothing" do
      before = WatermarkTracker.committed_watermark()

      assert {:error, 422, "boom"} = run_fixture("handler-error")

      assert WatermarkTracker.committed_watermark() == before
      assert ActionLog.read(before + 1, before + 10) == []
    end

    test "a rejected commit answers the call with 422 and writes nothing" do
      before = WatermarkTracker.committed_watermark()

      assert {:error, 422, details} = run_fixture("commit-rejected")
      assert details =~ "not_authorized"

      assert WatermarkTracker.committed_watermark() == before
      assert ActionLog.read(before + 1, before + 10) == []

      assert %{"1" => %{"ok" => false, "error" => %{"status" => 422, "error" => "rejected"}}} =
               replies_by_call_id(sent_frames())
    end
  end

  describe "out-of-order host calls" do
    test "replies are matched by call_id rather than arrival order" do
      assert {:ok, %{"read" => 2}} =
               run_fixture("out-of-order-get",
                 host: DelayedHost,
                 host_opts: [delays: %{"e_slow" => 150, "e_fast" => 0}, notify: self()],
                 max_in_flight: 8
               )

      assert reply_order(sent_frames()) == ["2", "1"]
      assert host_finished?("e_fast")
      assert host_finished?("e_slow")
    end

    test "max_in_flight: 1 runs the same fixture serially" do
      assert {:ok, %{"read" => 2}} =
               run_fixture("out-of-order-get",
                 host: DelayedHost,
                 host_opts: [delays: %{"e_slow" => 20, "e_fast" => 0}, notify: self()],
                 max_in_flight: 1
               )

      assert reply_order(sent_frames()) == ["1", "2"]
    end
  end

  describe "discarded work" do
    test "a call after result is never answered" do
      assert {:ok, %{"done" => true}} =
               run_fixture("call-after-result", host: DelayedHost, host_opts: [notify: self()])

      refute_received {:host_started, "e_doc"}
      assert reply_order(sent_frames()) == []
    end

    test "a worker that dies without a result ends the invocation" do
      assert {:error, 503, message} = run_fixture("crash")
      assert message =~ "worker exited"
      assert_received :functions_worker_closed
    end

    test "a fake that never replies hits the deadline and is closed once" do
      assert {:error, 408, "deadline exceeded"} =
               run_script([], deadline_ms: 50)

      assert_received :functions_worker_closed
      refute_receive :functions_worker_closed, 50
    end
  end

  describe "protocol failures" do
    test "a mismatched protocol version fails the invocation" do
      ready = Protocol.ready(1, "9.9.9", 99)

      assert {:error, 500, message} = run_script([%{"send" => ready}])
      assert message =~ "protocol version"
      assert_received :functions_worker_closed
    end

    test "log and fetch_audit frames are ignored in v1" do
      result = Protocol.result({:ok, %{"ok" => true}})

      script = [
        %{"send" => %{"type" => "log", "level" => "info", "message" => "hello"}},
        %{
          "send" => %{
            "type" => "fetch_audit",
            "method" => "GET",
            "url" => "https://example.com",
            "status" => 200,
            "duration_ms" => 1
          }
        },
        %{"send" => result}
      ]

      assert {:ok, %{"ok" => true}} = run_script(script)
    end

    test "an unexpected frame type fails the invocation" do
      assert {:error, 500, message} = run_script([%{"send" => %{"type" => "mystery"}}])
      assert message =~ "unexpected frame"
    end

    test "a malformed call frame fails the invocation" do
      script = [%{"send" => %{"type" => "call", "call_id" => "1"}}]

      assert {:error, 500, message} = run_script(script)
      assert message =~ "malformed call"
    end

    test "an unlisted op is a protocol error, not a silent null" do
      script = [
        %{"send" => Protocol.call("1", "query", %{})},
        %{
          "expect" => %{
            "type" => "reply",
            "call_id" => "1",
            "ok" => false,
            "error" => %{"error" => "protocol_error", "status" => 500}
          }
        }
      ]

      assert {:error, 500, message} = run_script(script)
      assert message =~ "unsupported host op"
    end

    test "a crashing host call fails the invocation" do
      script = [%{"send" => Protocol.call("1", "get", %{"id" => "e_doc"})}]

      capture_log(fn ->
        assert {:error, 500, message} = run_script(script, host: RaisingHost)
        assert message =~ "host call failed"
      end)
    end

    test "a host call that returns an invalid result fails the invocation" do
      script = [%{"send" => Protocol.call("1", "get", %{"id" => "e_doc"})}]

      assert {:error, 500, message} = run_script(script, host: BadHost)
      assert message =~ "invalid result"
    end
  end

  describe "worker start and send failures" do
    test "a transport that cannot start returns 503" do
      assert {:error, 503, message} = run_script([], transport: FailingWorker)
      assert message =~ "worker unavailable"
    end

    test "a transport that cannot accept invoke returns 503" do
      assert {:error, 503, message} = run_script([], transport: ClosedWorker)
      assert message =~ "worker unavailable"
    end

    test "a transport without a monitor is polled for liveness" do
      assert {:error, 503, message} = run_script([], transport: NoMonitorWorker)
      assert message =~ "worker exited"
    end
  end

  defp fields do
    hlc = generate_hlc()
    %{"title" => %{"type" => "lww", "value" => "Original", "hlc" => hlc}}
  end

  defp run_fixture(name, opts \\ []) do
    fixture = TestFunctions.load_fixture!(name)
    invoke_name = Enum.find_value(fixture["steps"], &get_in(&1, ["expect", "name"]))

    Invocation.run(
      Keyword.merge(
        [
          transport: RecordingWorker,
          invoke: TestFunctions.invoke(invoke_name),
          worker_opts: [script: fixture["steps"], notify: self()]
        ],
        opts
      )
    )
  end

  defp run_script(script, opts \\ []) do
    Invocation.run(
      Keyword.merge(
        [
          transport: RecordingWorker,
          invoke: TestFunctions.invoke("inline"),
          worker_opts: [script: script, notify: self()]
        ],
        opts
      )
    )
  end

  defp sent_frames, do: drain_sent([])

  defp drain_sent(acc) do
    receive do
      {:functions_worker_sent, frame} -> drain_sent([frame | acc])
    after
      0 -> Enum.reverse(acc)
    end
  end

  defp replies_by_call_id(frames) do
    frames
    |> Enum.filter(&(&1["type"] == "reply"))
    |> Map.new(fn reply -> {reply["call_id"], reply} end)
  end

  defp reply_order(frames) do
    for %{"type" => "reply", "call_id" => call_id} <- frames, do: call_id
  end

  defp host_finished?(entity_id) do
    receive do
      {:host_finished, ^entity_id} -> true
    after
      0 -> false
    end
  end
end
