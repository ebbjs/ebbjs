defmodule EbbServer.CORS.Policy do
  @moduledoc """
  The node's CORS policy, resolved once at boot.

  The policy has two parts:

    * `allow_any` — whether `Access-Control-Allow-Origin: *` is permitted.
      `EBB_CORS_ALLOW_ANY` is the explicit escape hatch. Unset, it follows
      the mode: `:bypass` admits `*` (local development), `:external` and
      `:tailscale` deny until origins are registered. `allow_any` is always
      logged at boot; it hands whatever credential the browser has to any
      site the user visits.
    * `origins` — the static origins from `EBB_CORS_ORIGINS`, normalized and
      unioned per request with the registered app origins. `*` is not a valid
      entry here; wildcard host patterns (`https://*.example.com`) are.

  `EbbServer.Application` calls `resolve!/1` before the listener starts and
  writes the result to `:ebb_server, :cors`. Per-request reads go through
  `current/0`, which never touches the environment, so a release cannot have
  a policy that changes under a live listener without a restart.

  A node that was never resolved (a direct module call in a test) reads as
  deny-all: `allow_any: false`, no static origins.
  """

  require Logger

  alias EbbServer.Apps.Origin

  @origins_env "EBB_CORS_ORIGINS"
  @allow_any_env "EBB_CORS_ALLOW_ANY"
  @config_key :cors

  @type t :: %{allow_any: boolean(), origins: [String.t()]}

  @doc """
  Resolves the policy for `auth_mode`, stores it, and logs anything the
  operator needs to see.

  Raises on an unparseable boolean or an invalid origin: a typo in a
  deployment must not silently widen or narrow browser admission.
  """
  @spec resolve!(atom()) :: t()
  def resolve!(auth_mode) do
    policy = %{
      allow_any: allow_any!(auth_mode),
      origins: origins!()
    }

    Application.put_env(:ebb_server, @config_key, policy)
    log(policy, auth_mode)

    policy
  end

  @doc "The resolved policy; deny-all when nothing was resolved."
  @spec current() :: t()
  def current do
    case Application.get_env(:ebb_server, @config_key) do
      %{allow_any: allow_any, origins: origins}
      when is_boolean(allow_any) and is_list(origins) ->
        %{allow_any: allow_any, origins: origins}

      _unresolved ->
        %{allow_any: false, origins: []}
    end
  end

  @doc "The static origins from the resolved policy."
  @spec origins() :: [String.t()]
  def origins, do: current().origins

  @doc "Whether the resolved policy admits `*`."
  @spec allow_any?() :: boolean()
  def allow_any?, do: current().allow_any

  # `bypass` is a dev mode with no credential in the browser, so `*` is its
  # default; every authenticated mode defaults to deny and needs registration.
  defp allow_any!(auth_mode) do
    case env_value(@allow_any_env) do
      nil ->
        auth_mode == :bypass

      raw ->
        case String.downcase(raw) do
          value when value in ["1", "true"] ->
            true

          value when value in ["0", "false"] ->
            false

          _other ->
            raise "#{@allow_any_env} must be one of: 1, true, 0, false; got #{inspect(raw)}"
        end
    end
  end

  defp origins! do
    case env_value(@origins_env) do
      nil ->
        []

      raw ->
        raw
        |> String.split(",")
        |> Enum.map(&String.trim/1)
        |> Enum.reject(&(&1 == ""))
        |> Enum.map(&normalize_origin!/1)
        |> Enum.uniq()
    end
  end

  defp normalize_origin!(origin) do
    case Origin.normalize(origin) do
      {:ok, canonical} ->
        canonical

      {:error, :invalid_origin} ->
        raise "#{@origins_env} contains an invalid origin: #{inspect(origin)}. " <>
                "Use an http(s) origin with no path, query, or fragment; " <>
                "`*` is set with #{@allow_any_env}, not here."
    end
  end

  defp env_value(name) do
    case System.get_env(name) do
      nil ->
        nil

      raw ->
        case String.trim(raw) do
          "" -> nil
          value -> value
        end
    end
  end

  defp log(%{allow_any: true}, :bypass) do
    Logger.warning(
      "cors: bypass mode admits any browser origin (*). This is for local development; " <>
        "browser admission is not authorization. Set #{@allow_any_env}=0 to require " <>
        "registered origins."
    )
  end

  defp log(%{allow_any: true}, _auth_mode) do
    Logger.warning(
      "cors: #{@allow_any_env} is active and admits any browser origin (*). " <>
        "Any site the user visits can act with the browser's credential; " <>
        "remove it and register app origins unless this is intentional."
    )
  end

  defp log(%{allow_any: false, origins: []}, _auth_mode) do
    Logger.info(
      "cors: no static origins; browser origins are admitted only through the app " <>
        "registry (register with POST /admin/apps or #{@origins_env})."
    )
  end

  defp log(%{allow_any: false, origins: origins}, _auth_mode) do
    Logger.info("cors: #{length(origins)} static origin(s) from #{@origins_env}.")
  end
end
