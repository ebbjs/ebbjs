defmodule EbbServer.Admin.Token do
  @moduledoc """
  The node-level admin credential every admin surface compares against.

  One token gates operator actions: deploying or activating a function
  (`EbbServer.Functions.Admin`) and managing the app registry
  (`EbbServer.Admin.Router`). It is presented as `Authorization: Bearer
  <token>` and is never an invoke grant or an actor identity.

  ## Resolution

  `EbbServer.Application` calls `resolve!/0` once at boot, before any listener
  accepts a request and before `EbbServer.Functions.resolve!/0` reads the
  value. Precedence, highest first:

    1. `EBB_ADMIN_TOKEN`
    2. `:ebb_server, :admin_token`
    3. `EBB_FUNCTIONS_ADMIN_TOKEN`
    4. `:ebb_server, :functions, :admin_token`

  The last two are the pre-promotion location and stay as a fallback, so an
  existing functions deployment keeps its credential without rewriting its
  configuration. `resolve!/0` writes the winner to `:ebb_server, :admin_token`
  and deletes the key when there is no winner. Blank values count as unset.

  `value/0` reads the resolved value and falls back to the functions key for a
  caller that runs before `resolve!/0` (a test or a direct module call).

  ## Failing closed

  A node with no token configured has no admin credential, so every admin
  route denies rather than opening. `authorize/2` distinguishes
  `{:error, :not_configured}` (no credential exists on this node) from
  `{:error, :denied}` (a credential exists and the request did not present
  it), so an HTTP surface can answer `403` for the former and `401` for the
  latter.

  Comparison hashes both the configured token and the presented one with
  SHA-256, then compares the digests with `Plug.Crypto.secure_compare/2`.
  `secure_compare/2` returns early on a length mismatch, so comparing the
  tokens directly would leak the configured token's length; fixed-width
  digests do not.
  """

  @server_env "EBB_ADMIN_TOKEN"
  @functions_env "EBB_FUNCTIONS_ADMIN_TOKEN"
  @server_key :admin_token
  @functions_key :functions

  @type error :: {:error, :denied} | {:error, :not_configured}

  @doc """
  Resolves the admin credential once and writes it to `:ebb_server, :admin_token`.

  Called by `EbbServer.Application` at boot. A blank winner is removed rather
  than stored as an empty string, so `value/0` cannot mistake it for a
  configured credential.
  """
  @spec resolve!() :: :ok
  def resolve! do
    case resolve_value() do
      nil -> Application.delete_env(:ebb_server, @server_key)
      token -> Application.put_env(:ebb_server, @server_key, token)
    end

    :ok
  end

  @doc """
  The credential the environment and configuration currently select.

  Pure: it reads the environment and application env but writes nothing. The
  functions boot resolution reuses it so the two surfaces cannot disagree
  about which source wins.
  """
  @spec resolve_value() :: String.t() | nil
  def resolve_value do
    env(@server_env) ||
      blank_to_nil(Application.get_env(:ebb_server, @server_key)) ||
      env(@functions_env) ||
      functions_value()
  end

  @doc """
  The effective admin credential, or `nil` when this node has none.

  Reads the value `resolve!/0` wrote, falling back to the functions key so a
  direct call before boot still sees a configured credential.
  """
  @spec value() :: String.t() | nil
  def value do
    case blank_to_nil(Application.get_env(:ebb_server, @server_key)) do
      nil -> functions_value()
      token -> token
    end
  end

  @doc """
  Authorizes a request against the admin credential.

  Options:

    * `:token` — the credential to compare against (default: `value/0`).
      Tests pass their own so they do not have to mutate application config.

  Returns `:ok`, `{:error, :denied}` for a missing, malformed, or wrong
  credential, or `{:error, :not_configured}` when no credential exists.
  """
  @spec authorize(Plug.Conn.t(), keyword()) :: :ok | error()
  def authorize(conn, opts \\ []) do
    token =
      case Keyword.fetch(opts, :token) do
        {:ok, value} -> value
        :error -> value()
      end

    authorize_with(conn, blank_to_nil(token))
  end

  defp authorize_with(_conn, nil), do: {:error, :not_configured}

  defp authorize_with(conn, token) do
    with {:ok, presented} <- bearer(Plug.Conn.get_req_header(conn, "authorization")),
         true <- Plug.Crypto.secure_compare(digest(presented), digest(token)) do
      :ok
    else
      _denied -> {:error, :denied}
    end
  end

  defp functions_value do
    :ebb_server
    |> Application.get_env(@functions_key, [])
    |> Keyword.get(:admin_token)
    |> blank_to_nil()
  end

  defp env(name) do
    name
    |> System.get_env()
    |> case do
      nil -> nil
      raw -> blank_to_nil(String.trim(raw))
    end
  end

  defp blank_to_nil(value) when is_binary(value) do
    if String.trim(value) == "", do: nil, else: value
  end

  defp blank_to_nil(_value), do: nil

  defp digest(value), do: :crypto.hash(:sha256, value)

  # The scheme is case-insensitive per RFC 6750; the token is not, and is
  # compared verbatim.
  defp bearer([header]) do
    case String.split(header, " ", parts: 2) do
      [scheme, presented] when presented != "" ->
        if String.downcase(scheme) == "bearer", do: {:ok, presented}, else: :error

      _malformed ->
        :error
    end
  end

  defp bearer(_headers), do: :error
end
