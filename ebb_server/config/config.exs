import Config

# `:functions` is the one nested key for the functions feature. `:enabled` is
# the only value with a defensible default: versions live in
# `<data_dir>/functions.db`, the worker transport defaults to the in-process
# fake, and there is no admin credential until one is configured. A
# `:bundle_dir` opts into the directory loader instead. `EBB_FUNCTIONS_ENABLED`
# overlays this at boot.
config :ebb_server, :functions, enabled: false

import_config "#{config_env()}.exs"
