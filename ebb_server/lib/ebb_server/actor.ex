defmodule EbbServer.Actor do
  @moduledoc """
  The authenticated principal `EbbServer.Sync.AuthPlug` resolved for a request.

  The plug assigns one to `conn.assigns.actor`. A request authenticated only by
  a functions service token has none: the service is the principal, so the key
  stays absent and `conn.assigns[:actor]` is `nil` there.

  `id` is the provider's own identifier, unprefixed, and the only field used for
  authorization. `provider` names the auth mode that resolved it, which lets a
  route tell an identity a client claimed (`:bypass`) from one a service or
  gateway verified (`:external`, `:tailscale`). `display_name` and
  `provider_id` are provider metadata for `GET /sync/identity`; they never grant
  access.
  """

  @enforce_keys [:id, :provider]
  defstruct [:id, :provider, :display_name, :provider_id]

  @type provider :: :bypass | :external | :tailscale

  @type t :: %__MODULE__{
          id: String.t(),
          provider: provider(),
          display_name: String.t() | nil,
          provider_id: integer() | nil
        }

  @doc """
  Builds the actor a mode resolved.

  `:display_name` and `:provider_id` are only meaningful for providers that
  supply them (today Tailscale); the other modes leave them unset.
  """
  @spec new(provider(), String.t(), keyword()) :: t()
  def new(provider, id, opts \\ []) do
    %__MODULE__{
      id: id,
      provider: provider,
      display_name: Keyword.get(opts, :display_name),
      provider_id: Keyword.get(opts, :provider_id)
    }
  end
end
