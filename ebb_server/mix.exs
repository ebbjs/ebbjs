# Elixir project configuration
defmodule EbbServer.MixProject do
  use Mix.Project

  def project do
    [
      app: :ebb_server,
      version: "0.1.0",
      elixir: "~> 1.17",
      elixirc_paths: elixirc_paths(Mix.env()),
      start_permanent: Mix.env() == :prod,
      deps: deps(),
      aliases: aliases(),
      test_coverage: test_coverage()
    ]
  end

  def application do
    [
      extra_applications: [:logger, :runtime_tools, :inets],
      mod: {EbbServer.Application, []}
    ]
  end

  defp elixirc_paths(:test), do: ["lib", "bench", "test/support"]
  defp elixirc_paths(:prod), do: ["lib"]
  defp elixirc_paths(_), do: ["lib", "bench"]

  # Coverage measures the code that ships: bench, mix-task and test-support
  # scaffolding compiled into `:test` only dilutes the gate. The entries below
  # and their reasoning live in docs/tooling/ebb-server-coverage.md; the
  # threshold is the staging point #632 and #641 move up as their tests land.
  defp test_coverage do
    [
      summary: [threshold: 89],
      ignore_modules: [
        ~r/^EbbServer\.Bench\./,
        ~r/^Mix\.Tasks\./,
        ~r/^EbbServer\.(TestHelpers|SSEHelpers|Integration\.)/,
        ~r/^EbbServer\.Sync\.Router\.OperationSchema$/,
        EbbServer.Storage.PreparedAction,
        EbbServer.ActionExport.Supervisor
      ]
    ]
  end

  defp aliases do
    # `mix dev` runs the server under MIX_ENV=dev. See Mix.Tasks.Dev for
    # details. No file watcher — restart after editing lib/ or config/.
    [dev: ["dev"]]
  end

  defp deps do
    [
      {:rocksdb, "~> 2.5"},
      {:exqlite, "~> 0.27"},
      {:msgpax, "~> 2.4"},
      {:bandit, "~> 1.5"},
      {:jason, "~> 1.4"},
      {:nanoid, "~> 2.1"},
      {:telemetry, "~> 1.0"},
      {:req, "~> 0.5"},
      {:credo, "~> 1.7", only: [:dev, :test], runtime: false},
      {:open_api_spex, "~> 3.22"}
    ]
  end
end
