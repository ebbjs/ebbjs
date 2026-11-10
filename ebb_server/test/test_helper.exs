# Tests that need a real Bun runtime are tagged `:bun` and excluded by
# default: Bun is an optional local/CI dependency (see
# `scripts/setup-ebb-server.sh`), so the suite must stay green without it.
# Run them with `mix test --include bun`. Latency measurements are excluded
# separately because they are reported, not asserted: run them with
# `mix test --include bun --include latency`.
ExUnit.start(exclude: [:bun, :latency])

# Clean up the application-supervised storage directory at the end of the
# test run. The directory is created by the `EbbServer.Application`
# supervisor's `Storage.Supervisor` (configured in `config/test.exs` to
# point at a per-run temp-dir path). Without this cleanup, `mix test` leaves
# the directory populated with RocksDB log files and a SQLite WAL — see
# ebbjs/ebbjs#56.
#
# The config exports the run's tag so both sides name the same path, and we
# only remove the directory if it lives under `System.tmp_dir!/0` so we
# never accidentally delete an unrelated path.
ExUnit.after_suite(fn _ ->
  tmp_root = System.tmp_dir!()
  tag = System.get_env("EBB_TEST_APP_STORAGE_TAG") || "ebb_server_test_app_storage"
  app_storage = Path.join([tmp_root, tag])

  if String.starts_with?(app_storage, tmp_root) and File.dir?(app_storage) do
    File.rm_rf!(app_storage)
  end

  # Also clean up any `data/` that landed at the project root — the
  # storage layer is configured to never create that path under test, but
  # if a previous interrupted run left state here we don't want it to
  # contaminate the next run or pollute git status. See ebbjs/ebbjs#56.
  cwd_data = Path.expand("./data", File.cwd!())

  if File.dir?(cwd_data) do
    File.rm_rf!(cwd_data)
  end
end)
