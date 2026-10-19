defmodule Mix.Tasks.Bench.Materialize do
  @shortdoc "Run the ebb_server read / materialization benchmark"

  @moduledoc """
  Reproducible read-path benchmark for `ebb_server` materialization.

      mix bench.materialize --sizes 100,500,1000,2000,5000 --runs 3 --reps 50

  Boots an isolated storage tree (the `:ebb_server` application is not
  started), seeds `content`-map documents of each size, and measures cold,
  dirty, clean, and query reads. Writes a Markdown report to
  `bench/results/`. See `EbbServer.Bench.Materialize.Options` for the full
  option list and `ebb_server/bench/RESULTS.md` for published runs.
  """

  use Mix.Task

  alias EbbServer.Bench.Materialize.{Options, Runner}

  @impl Mix.Task
  def run(args) do
    case Options.parse(args) do
      {:ok, config} -> Runner.run(config)
      {:error, message} -> Mix.raise(message)
    end
  end
end
