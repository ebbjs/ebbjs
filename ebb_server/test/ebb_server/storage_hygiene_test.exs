defmodule EbbServer.StorageHygieneTest do
  @moduledoc """
  Regression tests for ebbjs/ebbjs#56 — guards against the storage layer
  leaking state into the project tree during `mix test`.

  Some integration tests intentionally mutate the
  `Application.get_env(:ebb_server, :data_dir)` setting (see
  `EbbServer.Integration.StorageCase`), so we assert against the
  filesystem rather than the live application env.
  """

  use ExUnit.Case, async: false

  @project_root Path.expand("../..", __DIR__)

  test "Storage.Supervisor does not write to ./data during test boot" do
    # The Application starts Storage.Supervisor eagerly. By the time this
    # test runs it has already opened its database at the path from
    # config/test.exs — nowhere under the project root.
    cwd_data = Path.expand("./data", File.cwd!())

    refute File.dir?(cwd_data),
           "expected no ./data directory under the project tree " <>
             "(#{inspect(cwd_data)}) after `mix test` boot, but it exists. " <>
             "The Application's default `./data` data dir leaked into the " <>
             "repo. See issue #56."
  end
end
