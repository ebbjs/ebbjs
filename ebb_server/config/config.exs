import Config

# `:functions` is the one nested key for the functions feature. Functions are
# on by default: the milestone's hardening (bounds, secrets, service
# principals, pool, packaging) is what makes the flag safe to flip. The real
# Bun runner is the default transport, and boot fails loudly when Bun or the
# committed runner bundle is missing. A `:bundle_dir` opts into the directory
# loader instead. `EBB_FUNCTIONS_ENABLED` overlays this at boot.
config :ebb_server, :functions,
  enabled: true,
  transport: EbbServer.Functions.Worker.Bun

# Function logs carry the invocation they came from. The keys are declared
# here so the formatter prints them and Credo can see every metadata key the
# code uses.
config :logger, :default_formatter, metadata: [:function_name, :version, :invocation_id]

import_config "#{config_env()}.exs"
