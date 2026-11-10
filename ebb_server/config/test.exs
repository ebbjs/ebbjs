import Config

# Point the storage layer at a per-run directory under the OS temp dir so
# `mix test` never leaves a `data/` tree inside the repo. The suffix is
# stamped per invocation, so two suites running at once (two checkouts, or
# two agents in one checkout) cannot fight over one RocksDB lock. The tag is
# exported so `test/test_helper.exs` can clean the same directory up.
# The OS pid distinguishes concurrent suites (each `mix test` is its own VM);
# the unique integer distinguishes successive runs in one VM. Tests that pin a
# port set it explicitly.
run_tag = "#{System.pid()}_#{System.unique_integer([:positive])}"

# A per-run port and storage directory for the same reason: two suites at
# once must not fight over one listener or one RocksDB lock.
config :ebb_server, port: 20_000 + rem(:erlang.phash2(run_tag), 20_000)

app_storage_tag = "ebb_server_test_app_storage_#{run_tag}"
System.put_env("EBB_TEST_APP_STORAGE_TAG", app_storage_tag)
config :ebb_server, data_dir: Path.join(System.tmp_dir!(), app_storage_tag)
config :ebb_server, auth_mode: :bypass
# The app registry writes `apps.json`; a per-run directory keeps registrations
# (and deliberately corrupt-file tests) from leaking between suite runs.
config :ebb_server,
  apps_data_dir:
    Path.join(System.tmp_dir!(), "ebb_server_test_apps_#{System.unique_integer([:positive])}")

# Functions are on in production; the suite configures its own cache, store,
# and transport per test, so the application never starts a pool or opens a
# production database here.
config :ebb_server, :functions,
  enabled: false,
  transport: EbbServer.Functions.Worker.Fake,
  worker_opts: []

# The commit watchdog is disabled in the suite by default so the depth-1
# Writer keeps its inline commit path, which most storage tests pin. Watchdog
# tests pass an explicit `:commit_timeout_ms` through `start_writer/1`.
config :ebb_server, writer_commit_timeout_ms: 0
# Tests assert a conn_deliver sample from one subscriber; keep every delivery.
config :ebb_server, :fanout_conn_sample_rate, 1

# The 1 Hz gauge sampler is off by default in tests so its emissions cannot
# leak into other tests' telemetry assertions. Sampler tests start it directly.
config :ebb_server, EbbServer.Telemetry.Sampler, enabled: false

config :logger, level: :warning
# The suite must never spawn a real gateway: tests that exercise tailscale mode
# resolve the node themselves. The release image defaults to `:embedded`.
config :ebb_server, tailscale_node: :external
