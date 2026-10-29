defmodule Mix.Tasks.Bench.Actions do
  @shortdoc "Run the ebb_server Actions/sec benchmark"

  @moduledoc """
  Reproducible Actions/sec benchmark for the `ebb_server` write path.

      mix bench.actions --tier t2 --duration 120 --warmup 5 --concurrency 64 --batch-size 10

  Pipeline depth is a sweep over the number of `Writer.write_actions/1` calls
  a worker keeps outstanding (t0, t2, and t3 only):

      mix bench.actions --tier t2 --concurrency 8 --batch-size 100 \
        --updates-per-action 2 --distribution hot --in-flight 1,2,4

  A sweep measures a t0 depth-1 baseline first and then one full pass per
  depth, each against a fresh booted and seeded DB. Depth also raises the
  Writer's `max_in_flight` (capped at 4) and deepens the coalesced flush, so
  the report pairs it with `Actions/flush`; compare depths only at the same
  flush shape (see the control tables in `RESULTS.md`).

  Boots an isolated storage + sync tree in a temp directory (the
  `:ebb_server` application is not started), seeds a bench actor/group,
  runs the requested tier, and writes a Markdown report to
  `bench/results/`. See `EbbServer.Bench.Options` for the full option list
  and `ebb_server/bench/RESULTS.md` for published runs.

  ## Real-socket fan-out

  `--subscriber-socket` measures fan-out with the consumer off the server's
  schedulers: every subscriber is a real `GET /sync/live` connection over
  loopback TCP, consumed by `EbbServer.Bench.SocketClient` in a separate OS
  process (`--socket-processes`, `0` = auto). The report then carries the
  client's own receive → parse → count latency next to the server's
  `conn_chunk` hop:

      mix bench.actions --tier t4 --rate 300 --subscribers 1000 \
        --subscriber-socket --socket-processes 8 --duration 25 --warmup 5 \
        --concurrency 1 --batch-size 100 --updates-per-action 2 \
        --distribution hot --conn-sample-rate 100

  A client always fails the run when it reports connection/protocol errors
  or GSN holes on the wire. The client is also runnable on its own against a
  bench server that is already up (the numeric arguments are `port group_id
  actor_id connections warmup_s duration_s`):

      elixir -pa ebb_server/_build/dev/lib/ebb_server/ebin \
        -e "EbbServer.Bench.SocketClient.main(System.argv())" \
        4111 g_bench a_bench 100 5 25

  That form times its own window and prints the summary it would otherwise
  report over the control protocol.

  The run fails (non-zero exit) when a pass loses GSNs, ends with a frozen
  watermark, or reports rejected Actions or write/transport errors. Opt out
  with `--no-guardrails`; the report still records the violations. With
  `--baseline <report>`, each pass is also compared against the pass with the
  same workload config in a prior report, and an Actions/sec drop over 10% or
  a p50 rise over 25% fails the run. The bands live in
  `EbbServer.Bench.Guardrails` and are documented in `bench/RESULTS.md`.
  """

  use Mix.Task

  alias EbbServer.Bench.{Options, Runner}

  @impl Mix.Task
  def run(args) do
    case Options.parse(args) do
      {:ok, config} -> Runner.run(config)
      {:error, message} -> Mix.raise(message)
    end
  end
end
