import Config

config :ebb_server, port: 4001
config :ebb_server, data_dir: Path.expand("../data/test", __DIR__)

config :logger, level: :warning
