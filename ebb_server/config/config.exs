import Config

config :ebb_server, port: 4000

import_config "#{config_env()}.exs"
