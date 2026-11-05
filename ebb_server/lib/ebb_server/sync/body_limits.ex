defmodule EbbServer.Sync.BodyLimits do
  @moduledoc """
  Per-route request-body bounds for `EbbServer.Sync.Router`.

  Each limit is read from application env on every request, like
  `EbbServer.Sync.PresenceRateLimit.rate/0`: a runtime config change takes
  effect without a restart, and a non-positive or non-integer value raises
  `ArgumentError` instead of silently serving an unbounded body.

  | Function        | Key                             | Default     | Route                 |
  | --------------- | ------------------------------- | ----------- | --------------------- |
  | `actions/0`     | `:sync_actions_max_body_bytes`  | `8_000_000` | `POST /sync/actions`  |
  | `handshake/0`   | `:sync_handshake_max_body_bytes`| `1_048_576` | `POST /sync/handshake`|
  | `query/0`       | `:entities_query_max_body_bytes`| `1_048_576` | `POST /entities/query`|
  | `presence/0`    | `:presence_max_body_bytes`      | `32_768`    | `POST /sync/presence` |

  `:sync_actions_max_body_bytes` defaults to `8_000_000` because that is
  Plug's own default ceiling for one `read_body/2` call, and the Action path is
  the one route where a large batch is legitimate. Handshake and query payloads
  are small control messages, so a megabyte is already generous. Presence keeps
  the existing `:presence_max_body_bytes` key and 32 KiB default — four times
  the client's 8 KiB payload cap — because it is fanned out to every
  subscriber.
  """

  @defaults %{
    actions: {:sync_actions_max_body_bytes, 8_000_000},
    handshake: {:sync_handshake_max_body_bytes, 1_048_576},
    query: {:entities_query_max_body_bytes, 1_048_576},
    presence: {:presence_max_body_bytes, 32_768}
  }

  @doc "Bound for one `POST /sync/actions` batch."
  @spec actions() :: pos_integer()
  def actions, do: limit(:actions)

  @doc "Bound for a `POST /sync/handshake` body."
  @spec handshake() :: pos_integer()
  def handshake, do: limit(:handshake)

  @doc "Bound for a `POST /entities/query` body."
  @spec query() :: pos_integer()
  def query, do: limit(:query)

  @doc "Bound for a `POST /sync/presence` body."
  @spec presence() :: pos_integer()
  def presence, do: limit(:presence)

  defp limit(route) do
    {key, default} = Map.fetch!(@defaults, route)

    case Application.get_env(:ebb_server, key, default) do
      bytes when is_integer(bytes) and bytes > 0 ->
        bytes

      other ->
        raise ArgumentError,
              ":#{key} must be a positive integer, got: #{inspect(other)}"
    end
  end
end
