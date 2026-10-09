defmodule Mix.Tasks.Bench.Actions do
  @shortdoc "Run the ebb_server Actions/sec benchmark"

  @moduledoc """
  Reproducible Actions/sec benchmark for the `ebb_server` write path.

      mix bench.actions --tier t2 --duration 120 --warmup 5 --concurrency 64 --batch-size 10

  Boots an isolated storage + sync tree in a temp directory (the
  `:ebb_server` application is not started), seeds a bench actor/group,
  runs the requested tier, and writes a Markdown report to
  `bench/results/`. See `EbbServer.Bench.Options` for the full option list
  and `ebb_server/bench/RESULTS.md` for published runs.
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
