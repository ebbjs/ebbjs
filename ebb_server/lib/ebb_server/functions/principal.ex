defmodule EbbServer.Functions.Principal do
  @moduledoc """
  Who is invoking a function: a user/agent actor or a service credential.

  Two principal kinds reach `/functions`:

    * `:actor` — `AuthPlug` resolved the caller from the request's identity
      headers, exactly as it does for a sync route. Grants come from the
      actor's `groupMember.permissions` rows.
    * `:service` — the request carried `x-ebb-service-token`, and its sha256
      matches one entry in `config :ebb_server, :functions, services`. Grants
      are the credential's own `permissions` list, and the data identity is
      the credential's `subject_actor_id`, never a caller-supplied value.

  The service token is compared by hashing the presented value and comparing
  it with every configured credential's `token_sha256` using
  `Plug.Crypto.secure_compare/2`. Both sides are always 64 hex characters, so
  length leaks nothing, and the walk does not stop at a match.

  A presented service token is authoritative. It never falls back to the
  actor header, so a request cannot be a service when its token is valid and a
  user when it is not.
  """

  import Plug.Conn, only: [get_req_header: 2]

  alias EbbServer.Actor
  alias EbbServer.Functions

  @service_header "x-ebb-service-token"

  @type kind :: :actor | :service
  @type t :: %{
          required(:kind) => kind(),
          required(:id) => String.t(),
          required(:actor_id) => String.t(),
          required(:permissions) => [String.t()] | nil
        }
  @type error :: {:error, :unauthenticated | :denied}

  @doc """
  Resolves the request's principal.

  `:unauthenticated` means no principal was presented at all; `:denied` means
  a service token was presented and did not match a configured credential.
  Both make the router answer without a worker, but only `:denied` is a
  credential failure.
  """
  @spec resolve(Plug.Conn.t(), keyword()) :: {:ok, t()} | error()
  def resolve(conn, opts \\ []) do
    case get_req_header(conn, @service_header) do
      [] -> actor_principal(conn)
      [token] -> service_principal(token, opts)
      _repeated -> {:error, :denied}
    end
  end

  @doc """
  The service credentials the node accepts.

  Tests pass `:services` so they do not have to mutate application config.
  """
  @spec services(keyword()) :: [map()]
  def services(opts), do: Keyword.get(opts, :services) || Functions.services()

  defp actor_principal(conn) do
    case conn.assigns[:actor] do
      %Actor{id: actor_id} when is_binary(actor_id) and actor_id != "" ->
        {:ok, %{kind: :actor, id: actor_id, actor_id: actor_id, permissions: nil}}

      _missing ->
        {:error, :unauthenticated}
    end
  end

  defp service_principal(token, opts) do
    digest = Base.encode16(:crypto.hash(:sha256, token), case: :lower)

    # `Enum.reduce/3` rather than `Enum.find/2`: every credential is compared,
    # so the work does not stop at the first match.
    match =
      Enum.reduce(services(opts), nil, fn service, found ->
        if Plug.Crypto.secure_compare(digest, service.token_sha256) do
          found || service
        else
          found
        end
      end)

    case match do
      nil ->
        {:error, :denied}

      service ->
        {:ok,
         %{
           kind: :service,
           id: "svc:" <> service.id,
           actor_id: service.subject_actor_id,
           permissions: service.permissions
         }}
    end
  end
end
