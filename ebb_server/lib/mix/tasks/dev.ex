defmodule Mix.Tasks.Dev do
  @moduledoc """
  Starts the ebb_server under MIX_ENV=dev.

  A thin wrapper around `mix run --no-halt`. No file watcher — restart
  with `mix dev` after editing anything under `lib/` or `config/`.

  Usage:
      mix dev
  """
  use Mix.Task

  @impl true
  def run(_args) do
    Mix.Task.run("run", ["--no-halt"])
  end
end
