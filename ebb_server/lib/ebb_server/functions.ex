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

  ## The flag is boot-time

  `enabled?/0` decides whether `children/0` starts the bundle cache at all.
  `EBB_FUNCTIONS_ENABLED` overlays the compiled value — the environment wins,
  then `:enabled`, then `false` — in the order
  `EbbServer.Application.runtime_auth/0` uses for security-sensitive settings,
  so an operator's runtime instruction is not overridden by a value baked into
  a release. Blank env values count as unset, so an unfilled container
  variable cannot enable a feature by accident.

  Only `true`, `false`, `"true"`, `"false"`, `"1"` and `"0"` are understood.
  Anything else raises at boot: a typo in a deployment must not read as
  "disabled", because a feature that silently never starts is harder to
  diagnose than a node that refuses to boot.

  This is not a runtime kill switch. A release cannot reload its config, so
  the flag is fixed for the life of the node; the request-time check in
  `EbbServer.Sync.Router` exists only so a test or a dev node can mount the
  route without a release, and it never makes the route appear and disappear
  under load. The per-function kill switch is #595's disable, not this flag.

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

  Reads the environment first, then `config :ebb_server, :functions, enabled`,
  then `false`. Raises on a value outside the accepted set.
  """
  @spec enabled?() :: boolean()
  def enabled? do
    case enabled_source() do
      {:env, raw} -> parse_enabled!(raw, @enabled_env)
      {:app, raw} -> parse_enabled!(raw, @enabled_key)
      :unset -> false
    end
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

  # Env wins over app config; a blank env value is unset.
  defp enabled_source do
    case env_enabled() do
      nil ->
        case Keyword.fetch(config(), :enabled) do
          {:ok, nil} -> :unset
          {:ok, raw} -> {:app, raw}
          :error -> :unset
        end

      raw ->
        {:env, raw}
    end
  end

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
