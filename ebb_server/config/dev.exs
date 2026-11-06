import Config

config :ebb_server, auth_mode: :bypass
# The embedded gateway needs a built `ebb_tsnode` binary; a dev machine uses an
# external node (`tailscale serve`) or none at all. The release image defaults to
# `:embedded`.
config :ebb_server, tailscale_node: :external
