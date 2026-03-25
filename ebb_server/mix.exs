defmodule EbbServer.MixProject do
  use Mix.Project

  def project do
    [
      app: :ebb_server,
      version: "0.1.0",
      elixir: "~> 1.19",
      start_permanent: Mix.env() == :prod,
      deps: deps()
    ]
  end

  # Run "mix help compile.app" to learn about applications.
  def application do
    [
      extra_applications: [:logger],
      mod: {EbbServer.Application, []}
    ]
  end

  # Run "mix help deps" to learn about dependencies.
  defp deps do
    [
      # {:dep_from_hexpm, "~> 0.3.0"},
      # {:dep_from_git, git: "https://github.com/elixir-lang/my_dep.git", tag: "0.1.0"}
      # HTTP server
      {:plug_cowboy, "~> 2.7"},
      # SQLite3 bindings
      {:exqlite, "~> 0.27"},
      # JSON encoding/decoding
      {:jason, "~> 1.4"},
      # ID generation
      {:nanoid, "~> 2.1"}
    ]
  end
end
