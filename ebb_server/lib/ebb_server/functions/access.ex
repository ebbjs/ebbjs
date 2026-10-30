defmodule EbbServer.Functions.Access do
  @moduledoc """
  Decides whether a resolved caller may invoke one function.

  Invocation is an ordinary permission. A caller passes when any membership
  row for it holds `function.<name>` or `function.*`, unless the function
  declares `access: "authenticated"`, which admits any resolved principal.
  A grant is matched as a literal string: `.` and `*` are not in the name
  grammar, so `function.<name>` has exactly one reading, and there is no case
  folding because the binding name, route, and permission suffix are the same
  string.

  Only `"granted"` and `"authenticated"` are understood. Anything else — a
  missing or unrecognized `access` value, an unresolved actor, or a name
  outside the grammar — is denied. The module fails closed rather than
  defaulting open, and permission-gated (`"granted"`) is the posture the
  envelope declares when it offers no override.

  The router calls this before checking out a worker, so a denied request
  spawns nothing.

  Deploy is a separate admin credential and never implies invoke permission:
  an actor that may publish a bundle still needs a grant to call it.
  """

  alias EbbServer.Storage.{CacheTables, GroupCache}

  @type access :: String.t() | nil
  @type error :: {:error, :denied}

  # A name is a JavaScript identifier: the same string is the binding name,
  # the route segment, and the permission suffix. The reserved `default`
  # cannot be a named export, and a longer identifier would not be addressable.
  @name_pattern ~r/\A[A-Za-z_][A-Za-z0-9_]{0,63}\z/
  @reserved_name "default"

  @doc """
  Authorizes `actor_id` to invoke `name`.

  Options:

    * `:table` — the ETS table holding actor memberships (default
      `CacheTables.group_members/0`). Tests pass their own table to stay
      isolated from the running cache.
  """
  @spec authorize(access(), term(), term(), keyword()) :: :ok | error()
  def authorize(access, actor_id, name, opts \\ []) do
    with true <- resolved_actor?(actor_id),
         true <- valid_name?(name) do
      decide(access, actor_id, name, opts)
    else
      _ -> {:error, :denied}
    end
  end

  defp decide("authenticated", _actor_id, _name, _opts), do: :ok

  defp decide("granted", actor_id, name, opts) do
    table = Keyword.get(opts, :table, CacheTables.group_members())

    if granted?(actor_id, name, table), do: :ok, else: {:error, :denied}
  end

  defp decide(_access, _actor_id, _name, _opts), do: {:error, :denied}

  defp resolved_actor?(actor_id), do: is_binary(actor_id) and actor_id != ""

  defp valid_name?(name) when is_binary(name) and name != @reserved_name do
    Regex.match?(@name_pattern, name)
  end

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
