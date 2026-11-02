defmodule EbbServer.Functions do
  @moduledoc """
  Boot-time configuration for the functions feature.

  Everything functions-related is read from the one nested key,
  `config :ebb_server, :functions`, with no flat aliases:

      config :ebb_server, :functions,
        enabled: true,
        bundle_dir: "/srv/functions/bundles",
        transport: EbbServer.Functions.Worker.Fake,
        worker_opts: []

  ## The flag is resolved once, at boot

  `EBB_FUNCTIONS_ENABLED` overlays the compiled value — the environment wins,
  then `:enabled`, then `false` — in the order
  `EbbServer.Application.runtime_auth/0` uses for security-sensitive settings,
  so an operator's runtime instruction is not overridden by a value baked into
  a release. `EbbServer.Application` calls `resolve!/0` once, which writes the
  winner back into `:enabled`; after that `enabled?/0` reads only the resolved
  application value and never the environment.

  That single resolution is what makes the flag boot-time rather than a kill
  switch. A release cannot reload its config, so a value read per request
  would look flippable without being able to start or stop the bundle cache,
  and the route and the cache could disagree: a route that answers while no
  cache exists is a `500` for every caller. Resolving once keeps both readers
  on the same bool for the life of the node. The real per-function kill switch
  is #595's disable, not this flag.

  Only `true`, `false`, `"true"`, `"false"`, `"1"` and `"0"` are understood.
  Anything else raises at boot: a typo in a deployment must not read as
  "disabled", because a feature that silently never starts is harder to
  diagnose than a node that refuses to boot. Blank env values count as unset,
  so an unfilled container variable cannot enable a feature by accident.

  ## Injection seams

  `:transport` and `:worker_opts` are how v1 reaches a worker. They are the
  seam #593 replaces with the real runner: the transport is a module
  implementing `EbbServer.Functions.Worker` (default
  `EbbServer.Functions.Worker.Fake`, the in-process scripted fake) and
  `worker_opts/0` is handed to it untouched on every invocation. Nothing else
  in the server knows which worker a function ran on, so swapping the runner
  is a config change plus a new transport module.

  `:bundle_dir` is required while the feature is enabled: the directory loader
  addresses bundles by filename, so there is no useful default and a node
  booted without one raises rather than serving an empty directory.
  """

  alias EbbServer.Functions.Bundle.DirLoader
  alias EbbServer.Functions.BundleCache
  alias EbbServer.Functions.Worker.Fake

  @enabled_env "EBB_FUNCTIONS_ENABLED"
  @enabled_key ":ebb_server, :functions, enabled"
  @config_key :functions

  @doc """
  Whether functions are enabled on this node.

  Reads the value `resolve!/0` wrote at boot, defaulting to `false`. Raises on
  a value outside the accepted set, which can only come from a hand-edited
  application env after boot.
  """
  @spec enabled?() :: boolean()
  def enabled? do
    case Keyword.fetch(config(), :enabled) do
      {:ok, nil} -> false
      {:ok, raw} -> parse_enabled!(raw, @enabled_key)
      :error -> false
    end
  end

  @doc """
  The flag the environment asks for, falling back to the compiled value.

  `EbbServer.Application` calls this once through `resolve!/0`; tests call it
  directly to prove the precedence without restarting the application.
  """
  @spec resolve() :: boolean()
  def resolve do
    case env_enabled() do
      nil -> enabled?()
      raw -> parse_enabled!(raw, @enabled_env)
    end
  end

  @doc """
  Resolves the flag once and writes it back into `:ebb_server, :functions`.

  Called by `EbbServer.Application.start/2` before `children/0`, the same way
  the auth mode is resolved and written back before `AuthPlug` reads it. A
  booted node never consults the environment again.
  """
  @spec resolve!() :: :ok
  def resolve! do
    Application.put_env(:ebb_server, @config_key, Keyword.put(config(), :enabled, resolve()))
    :ok
  end

  @doc """
  Children to start under the application supervisor.

  Empty when disabled, so an unconfigured node pays nothing for the feature —
  the same shape as `EbbServer.Application.action_export_children/0`.
  """
  @spec children() :: [Supervisor.child_spec()]
  def children do
    if enabled?() do
      [
        {BundleCache, loader: DirLoader, loader_opts: [dir: bundle_dir!()]}
      ]
    else
      []
    end
  end

  @doc """
  The directory bundles are loaded from.

  Raises when it is missing: enabling functions without one means the loader
  has nothing to index, which is a deployment mistake, not a default.
  """
  @spec bundle_dir!() :: String.t()
  def bundle_dir! do
    case config(:bundle_dir) do
      dir when is_binary(dir) and dir != "" ->
        dir

      _ ->
        raise ":ebb_server, :functions is enabled but :bundle_dir is not set. " <>
                "Set config :ebb_server, :functions, bundle_dir: \"/path/to/bundles\"."
    end
  end

  @doc """
  The worker transport module, the v1 seam #593 replaces.
  """
  @spec transport() :: module()
  def transport, do: Keyword.get(config(), :transport, Fake)

  @doc """
  Options passed to the transport for every invocation, the v1 seam #593
  replaces.
  """
  @spec worker_opts() :: keyword()
  def worker_opts, do: Keyword.get(config(), :worker_opts, [])

  defp config, do: Application.get_env(:ebb_server, @config_key, [])

  defp config(key), do: Keyword.get(config(), key)

  # A blank env value is unset, not false.

  defp env_enabled do
    case System.get_env(@enabled_env) do
      nil -> nil
      raw -> if String.trim(raw) == "", do: nil, else: String.trim(raw)
    end
  end

  defp parse_enabled!(true, _source), do: true
  defp parse_enabled!(false, _source), do: false
  defp parse_enabled!("true", _source), do: true
  defp parse_enabled!("false", _source), do: false
  defp parse_enabled!("1", _source), do: true
  defp parse_enabled!("0", _source), do: false

  defp parse_enabled!(raw, source) do
    raise "#{source} must be true or false, got #{inspect(raw)}. " <>
            "Set it to true or false (the strings 1 and 0 are accepted for " <>
            "#{@enabled_env}), or remove it to leave functions disabled."
  end
end
