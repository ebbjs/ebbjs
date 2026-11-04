defmodule EbbServer.Functions do
  @moduledoc """
  Boot-time configuration for the functions feature.

  Everything functions-related is read from the one nested key,
  `config :ebb_server, :functions`, with no flat aliases:

      config :ebb_server, :functions,
        enabled: true,
        admin_token: "deploy-secret",
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

  ## Where bundles come from

  Versions live in `data/functions.db`, owned by `EbbServer.Functions.Store`,
  and `EbbServer.Functions.Bundle.StoreLoader` reads the active row out of it.
  That is the production home: an upload writes a row, an activation moves the
  name's pointer, and both survive a restart without a directory to mount.

  `:bundle_dir` selects the older directory loader instead — the way #680's
  tests and a dev loop address a bundle by filename. When it is set (non-blank)
  the cache runs over `Bundle.DirLoader` and no store is started; when it is
  absent the store is started first and the cache reads through
  `Bundle.StoreLoader`. The cache itself never learns which one it has.

  ## The admin credential

  Deploy and activate are gated by `:admin_token`, a separate deploy credential
  and never an invoke grant: an actor holding it still needs a
  `function.<name>` grant to call anything. `EbbServer.Functions.Admin`
  compares it in constant time, and a node configured without one has no admin
  credential at all rather than an open route. It is deliberately not overlaid
  from the environment here — secrets are #597's — so this module never reads
  the environment for anything but the boot flag.
  """

  alias EbbServer.Functions.Bundle.{DirLoader, StoreLoader}
  alias EbbServer.Functions.BundleCache
  alias EbbServer.Functions.Store
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

  When enabled with a `:bundle_dir`, the cache runs over the directory loader.
  Otherwise the store is started before the cache, because the cache resolves
  every invocation through it. Options:

    * `:data_dir` — the store's directory (default the application's resolved
      `:data_dir`, then `"./data"`); the database is `<data_dir>/functions.db`
  """
  @spec children(keyword()) :: [Supervisor.child_spec()]
  def children(opts \\ []) do
    if enabled?() do
      case bundle_dir() do
        nil -> store_children(opts)
        dir -> [{BundleCache, loader: DirLoader, loader_opts: [dir: dir]}]
      end
    else
      []
    end
  end

  # The store must be started before the cache: every invocation the cache
  # serves resolves a version through it.
  defp store_children(opts) do
    [
      {Store, data_dir: data_dir(opts), retention: retention()},
      {BundleCache, loader: StoreLoader, loader_opts: [store: Store]}
    ]
  end

  @doc """
  The directory bundles are loaded from, when one is configured.

  Raises when it is missing: a caller that wants the directory loader has to
  name a directory. `children/1` only calls this when a non-blank `:bundle_dir`
  is configured; without one the store is the bundle source.
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
  The admin credential deploy and activate require.

  Unset or blank means no admin credential exists, so those routes deny rather
  than open. It is never an invoke grant: see `EbbServer.Functions.Admin`.
  """
  @spec admin_token() :: String.t() | nil
  def admin_token do
    case config(:admin_token) do
      token when is_binary(token) -> if String.trim(token) == "", do: nil, else: token
      _token -> nil
    end
  end

  @doc """
  How many unpinned versions per name retention keeps. Pinned versions and the
  active one are kept in addition to this count.
  """
  @spec retention() :: non_neg_integer()
  def retention, do: Keyword.get(config(), :retention, 20)

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

  defp bundle_dir do
    case config(:bundle_dir) do
      dir when is_binary(dir) and dir != "" -> dir
      _dir -> nil
    end
  end

  defp data_dir(opts) do
    Keyword.get_lazy(opts, :data_dir, fn ->
      Application.get_env(:ebb_server, :data_dir, "./data")
    end)
  end

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
