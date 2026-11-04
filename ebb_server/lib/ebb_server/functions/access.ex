defmodule EbbServer.Functions.Access do
  @moduledoc """
  Decides whether a resolved caller may invoke one function.

  Invocation is an ordinary permission. An actor passes when any membership
  row for it holds `function.<name>` or `function.*`; a service credential
  passes when its own `permissions` list does. Either kind passes when the
  function declares `access: "authenticated"`, which admits any resolved
  principal. A grant is matched as a literal string: `.` and `*` are not in
  the name grammar, so `function.<name>` has exactly one reading, and there is
  no case folding because the binding name, route, and permission suffix are
  the same string.

  Only `"granted"` and `"authenticated"` are understood. Anything else — a
  missing or unrecognized `access` value, an unresolved principal, or a name
  outside the grammar — is denied. The module fails closed rather than
  defaulting open, and permission-gated (`"granted"`) is the posture the
  envelope declares when it offers no override.

  The router calls this before checking out a worker, so a denied request
  spawns nothing.

  Deploy is a separate admin credential and never implies invoke permission:
  an actor that may publish a bundle still needs a grant to call it.
  """

  alias EbbServer.Functions.Bundle
  alias EbbServer.Storage.{CacheTables, GroupCache}

  @type access :: String.t() | nil
  @type principal :: EbbServer.Functions.Principal.t() | String.t()
  @type error :: {:error, :denied}

  # The same string is the route segment and the permission suffix. The grammar
  # lives in `Bundle` because that is where an envelope is validated; repeating
  # it here would let the two definitions drift.
  @doc """
  Authorizes `principal` to invoke `name`.

  A principal is `EbbServer.Functions.Principal.resolve/2`'s map. A bare
  actor id is accepted for callers that only have one (the storage-facing
  tests) and is treated as `:actor` with group-cache grants.

  Options:

    * `:table` — the ETS table holding actor memberships (default
      `CacheTables.group_members/0`). Tests pass their own table to stay
      isolated from the running cache.
  """
  @spec authorize(access(), principal(), term(), keyword()) :: :ok | error()
  def authorize(access, principal, name, opts \\ []) do
    with {:ok, principal} <- normalize(principal),
         true <- valid_name?(name) do
      decide(access, principal, name, opts)
    else
      _ -> {:error, :denied}
    end
  end

  defp normalize(%{kind: :actor, actor_id: actor_id} = principal)
       when is_binary(actor_id) and actor_id != "" do
    {:ok, principal}
  end

  defp normalize(%{kind: :service, permissions: permissions} = principal)
       when is_list(permissions) do
    {:ok, principal}
  end

  defp normalize(actor_id) when is_binary(actor_id) and actor_id != "" do
    {:ok, %{kind: :actor, id: actor_id, actor_id: actor_id, permissions: nil}}
  end

  defp normalize(_principal), do: :error

  defp decide("authenticated", _principal, _name, _opts), do: :ok

  defp decide("granted", %{kind: :service, permissions: permissions}, name, _opts) do
    if holds_grant?(permissions, name), do: :ok, else: {:error, :denied}
  end

  defp decide("granted", %{kind: :actor, actor_id: actor_id}, name, opts) do
    table = Keyword.get(opts, :table, CacheTables.group_members())

    if granted?(actor_id, name, table), do: :ok, else: {:error, :denied}
  end

  defp decide(_access, _principal, _name, _opts), do: {:error, :denied}

  defp valid_name?(name) when is_binary(name), do: Bundle.valid_name?(name)
  defp valid_name?(_name), do: false

  defp granted?(actor_id, name, table) do
    actor_id
    |> GroupCache.get_actor_groups(table)
    |> Enum.any?(fn membership -> holds_grant?(membership[:permissions], name) end)
  end

  defp holds_grant?(permissions, name) when is_list(permissions) do
    Enum.any?(permissions, fn
      "function.*" -> true
      permission -> permission == "function." <> name
    end)
  end

  defp holds_grant?(_permissions, _name), do: false
end
