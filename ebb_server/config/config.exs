import Config

config :ebb_server, port: 4000
config :ebb_server, data_dir: "./data"

import_config "#{config_env()}.exs"
