defmodule EbbServer.Functions.BunLatencyTest do
  @moduledoc """
  Reports real-runner invocation latency at both host-call concurrency caps.

  The numbers are printed, not asserted: process spawn and host-call scheduling
  vary with the machine, and #593 uses them to decide whether #597's
  pre-warmed pool is required. The test is tagged `:latency` rather than
  `:bun` so `mix test --include bun` stays focused on correctness; run it with
  `mix test --include latency test/ebb_server/functions/bun_latency_test.exs`.
  """

  use ExUnit.Case, async: false

  alias EbbServer.Functions.{Bundle, Invocation, Protocol}
  alias EbbServer.Functions.Worker.Bun, as: BunWorker
  alias EbbServer.TestFunctions.Bundles
  alias EbbServer.TestFunctions.DelayedHost
  alias EbbServer.TestFunctions.Bun, as: BunSupport

  @samples 9

  @moduletag :latency
  @moduletag skip:
               if(BunSupport.available?(),
                 do: false,
                 else: "Bun or packages/runner is not installed"
               )

  test "two host calls at max_in_flight 8 and 1" do
    dir = Bundles.tmp_bundle_dir()
    name = "latencyReadTwo"

    code = """
    var __ebbFunction = (() => {
      return { #{name}: async (ctx) => Promise.all([ctx.get("e_slow"), ctx.get("e_fast")]) };
    })();
    """

    Bundles.write_bundle!(
      dir,
      Bundles.envelope(name, %{"digest" => Bundle.digest_for(code)}),
      code
    )

    for cap <- [8, 1] do
      # One warm-up run keeps Bun's first-process cost out of the sample.
      run(dir, name, code, cap)

      timings =
        for _ <- 1..@samples do
          started = System.monotonic_time(:microsecond)
          assert {:ok, _} = run(dir, name, code, cap)
          System.monotonic_time(:microsecond) - started
        end

      sorted = Enum.sort(timings)
      p50 = Enum.at(sorted, div(@samples, 2))
      p95 = Enum.at(sorted, @samples - 1)

      IO.puts(
        "max_in_flight=#{cap}: p50=#{Float.round(p50 / 1000, 1)}ms p95=#{Float.round(p95 / 1000, 1)}ms"
      )
    end
  end

  defp run(dir, name, code, cap) do
    Invocation.run(
      transport: BunWorker,
      invoke: frame(name, code),
      worker_opts: BunSupport.transport_opts(dir),
      host: DelayedHost,
      host_opts: [delays: %{"e_slow" => 50, "e_fast" => 0}],
      max_in_flight: cap,
      deadline_ms: 10_000
    )
  end

  defp frame(name, code) do
    Protocol.invoke(%{
      "invocation_id" => "inv_#{System.unique_integer([:positive])}",
      "name" => name,
      "version" => "1.0.0",
      "digest" => "sha256:" <> String.duplicate("0", 64),
      "bundle" => code,
      "entry" => name,
      "input" => %{},
      "subject_actor_id" => "a_test",
      "env" => %{},
      "limits" => %{"timeout_ms" => 10_000, "max_host_calls" => 1_000}
    })
  end
end
