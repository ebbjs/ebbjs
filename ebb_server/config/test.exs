import Config

# Point the storage layer at a per-run directory under the OS temp dir so
# `mix test` never leaves a `data/` tree inside the repo. `System.tmp_dir!/0`
# is evaluated once at boot — every `mix test` invocation gets a fresh path
# because the BEAM exits between runs, so there's no risk of stale lock
# files carrying over.
config :ebb_server, port: 4001
config :ebb_server, data_dir: Path.join(System.tmp_dir!(), "ebb_server_test_app_storage")
config :ebb_server, auth_mode: :bypass

# The 1 Hz gauge sampler is off by default in tests so its emissions cannot
# leak into other tests' telemetry assertions. Sampler tests start it directly.
config :ebb_server, EbbServer.Telemetry.Sampler, enabled: false

config :logger, level: :warning
