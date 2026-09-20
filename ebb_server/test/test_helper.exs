ExUnit.start()

# Clean up the application-supervised storage directory at the end of the
# test run. The directory is created by the `EbbServer.Application`
# supervisor's `Storage.Supervisor` (configured in `config/test.exs` to
# point at a temp-dir path). Without this cleanup, `mix test` leaves
# `/tmp/ebb_server_test_app_storage/` populated with RocksDB log files
# and a SQLite WAL — see ebbjs/ebbjs#56.
#
# We compute the same path the config used so the two stay in sync, and
# only remove the directory if it lives under `System.tmp_dir!/0` so we
# never accidentally delete an unrelated path.
ExUnit.after_suite(fn _ ->
  tmp_root = System.tmp_dir!()
  app_storage = Path.join([tmp_root, "ebb_server_test_app_storage"])

  if String.starts_with?(app_storage, tmp_root) and File.dir?(app_storage) do
    File.rm_rf!(app_storage)
  end
end)
