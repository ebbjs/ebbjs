import Config

# `:functions` is the one nested key for the functions feature. `:enabled` is
# the only value with a defensible default: there is no bundle directory to
# guess, and the worker transport defaults to the in-process fake in
# `EbbServer.Functions`. `EBB_FUNCTIONS_ENABLED` overlays this at boot.
config :ebb_server, :functions, enabled: false

import_config "#{config_env()}.exs"
