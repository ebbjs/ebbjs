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
      aliases: aliases()
    ]
  end

  def application do
    [
      extra_applications: [:logger, :runtime_tools, :inets],
      mod: {EbbServer.Application, []}
    ]
  end

  defp elixirc_paths(:test), do: ["lib", "test/support"]
  defp elixirc_paths(_), do: ["lib"]

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
      {:req, "~> 0.5"},
      {:credo, "~> 1.7", only: [:dev, :test], runtime: false},
      {:open_api_spex, "~> 3.22"}
    ]
  end
end
