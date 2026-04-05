import Config

config :ebb_server, port: 4000
config :ebb_server, data_dir: System.get_env("EBB_DATA_DIR") || Path.expand("../data", __DIR__)

# config :ebb_server, auth_url: "http://localhost:3001/auth"
# config :ebb_server, auth_mode: :external  # default

import_config "#{config_env()}.exs"
