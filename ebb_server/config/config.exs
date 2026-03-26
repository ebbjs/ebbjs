import Config

config :ebb_server, port: 4000
config :ebb_server, data_dir: System.get_env("EBB_DATA_DIR") || Path.expand("../data", __DIR__)

import_config "#{config_env()}.exs"
