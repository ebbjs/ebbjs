import Config

config :ebb_server, port: 4001
config :ebb_server, data_dir: Path.expand("../data/test", __DIR__)
config :ebb_server, auth_mode: :bypass

config :logger, level: :warning
