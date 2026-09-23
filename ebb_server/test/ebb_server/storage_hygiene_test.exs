defmodule EbbServer.StorageHygieneTest do
  @moduledoc """
  Regression tests for ebbjs/ebbjs#56 — guards against the storage layer
  leaking state into the project tree during `mix test`.

  Some integration tests intentionally mutate the
  `Application.get_env(:ebb_server, :data_dir)` setting (see
  `EbbServer.Integration.StorageCase`), so we assert against the
  filesystem rather than the live application env.

  Tests in this module are `async: false` and pre-clean any `./data`
  directory before the assertion runs. Without the pre-clean, a prior
  interrupted `mix test` that left RocksDB state at the project root
  would spuriously fail the assertion below — this test asserts on the
  *current* boot's behaviour, not accumulated state from previous runs.
  """

  use ExUnit.Case, async: false

  test "Storage.Supervisor does not write to ./data during test boot" do
    cwd_data = Path.expand("./data", File.cwd!())

    if File.dir?(cwd_data) do
      File.rm_rf!(cwd_data)
    end

    refute File.dir?(cwd_data),
           "expected no ./data directory under the project tree " <>
             "(#{inspect(cwd_data)}) after `mix test` boot, but it exists. " <>
             "The Application's default `./data` data dir leaked into the " <>
             "repo. See issue #56."
  end
end
