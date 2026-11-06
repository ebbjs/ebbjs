defmodule EbbServer.Functions do
  @moduledoc """
  Boot-time configuration for the functions feature.

  Everything functions-related is read from the one nested key,
  `config :ebb_server, :functions`, with no flat aliases:

      config :ebb_server, :functions,
        enabled: true,
        admin_token: "deploy-secret",
        transport: EbbServer.Functions.Worker.Bun,
        env: %{"proofreadDocument" => ["PROOFREAD_API_KEY"]}

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

  ## Secrets are resolved once too

  `:env` names the environment variables each function may read:
  `%{"proofreadDocument" => ["PROOFREAD_API_KEY"]}`. `resolve!/0` reads those
  values from the server environment and writes the resolved map back, so an
  invocation never touches `System.get_env/1` and a value cannot change under
  a running node. A named key with no value is recorded as missing, and the
  invocation fails with `missing_secret` before a worker exists. Values never
  appear in logs, telemetry, or error responses.

  ## The admin credential

  Deploy and activate are gated by `:admin_token`, a separate deploy credential
  and never an invoke grant: an actor holding it still needs a
  `function.<name>` grant to call anything. `EBB_FUNCTIONS_ADMIN_TOKEN` overlays
  it with the same precedence as the boot flag, and a blank value counts as
  unset. `EbbServer.Functions.Admin` compares it in constant time, and a node
  configured without one has no admin credential at all rather than an open
  route.

  Rotation is a restart: resolve the new value into `:admin_token`, start the
  node, and the old credential stops working when the old node stops. There is
  no two-token overlap window, because a release cannot reload its config and
  a rotating token that stayed valid on the old node would not be a rotation.

  ## Service principals

  `:services` is a static list of job/webhook credentials. Each presents its
  token in `x-ebb-service-token`, and the server hashes the presented value and
  compares it with the configured `token_sha256` in constant time. The
  credential's `subject_actor_id` is the data identity for reads and writes and
  its `permissions` are the invoke grants; it never grants what the subject
  actor could not do itself.
  """

  alias EbbServer.Admin.Token
  alias EbbServer.Functions.Bundle.{DirLoader, StoreLoader}
  alias EbbServer.Functions.BundleCache
  alias EbbServer.Functions.Store
  alias EbbServer.Functions.Worker.Bun
  alias EbbServer.Functions.Worker.Pool

  @enabled_env "EBB_FUNCTIONS_ENABLED"
  @enabled_key ":ebb_server, :functions, enabled"
  @config_key :functions

  @default_max_host_calls 1_000
  @default_max_log_lines 200
  @default_max_log_bytes 64 * 1024
  @default_max_invoke_body_bytes 256 * 1024
  @default_queue_limit 20
  @default_queue_timeout_ms 5_000
  @default_memory_bytes 256 * 1024 * 1024
  # Bun's runtime reserves address space before a handler allocates anything
  # (JSC's heap reservations, the thread pool, mapped libraries). A `ulimit -v`
  # at the function's budget alone kills a perfectly ordinary worker at boot, so
  # the OS cap is the budget plus this headroom; it bounds what a runaway
  # handler can allocate rather than pretending to be a byte-exact heap limit.
  @address_space_overhead_bytes 768 * 1024 * 1024

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
    case env_value(@enabled_env) do
      nil -> enabled?()
      raw -> parse_enabled!(raw, @enabled_env)
    end
  end

  @doc """
  Resolves the flag, the admin credential, the secret map, and the service
  list once and writes them back into `:ebb_server, :functions`.

  Called by `EbbServer.Application.start/2` before `children/0`, the same way
  the auth mode is resolved and written back before `AuthPlug` reads it. A
  booted node never consults the environment again.

  Raises on a malformed setting: a typo in a service entry, a non-list `:env`
  value, or an unusable admin token is a boot failure with an actionable
  message, not a request-time surprise.
  """
  @spec resolve!() :: :ok
  def resolve! do
    resolved =
      config()
      |> Keyword.put(:enabled, resolve())
      |> put_resolved(:admin_token, resolve_admin_token())
      |> resolve_secrets()
      |> Keyword.put(:services, validate_services!(Keyword.get(config(), :services, [])))

    Application.put_env(:ebb_server, @config_key, resolved)
    :ok
  end

  @doc """
  Children to start under the application supervisor.

  Empty when disabled, so an unconfigured node pays nothing for the feature —
  the same shape as `EbbServer.Application.action_export_children/0`.

  When enabled with a `:bundle_dir`, the cache runs over the directory loader.
  Otherwise the store is started before the cache, because the cache resolves
  every invocation through it. The stats owner and the worker pool follow; the
  pool is only started for the real Bun transport, because the in-process fake
  is scripted per invocation and has nothing to pre-warm.

  Options:

    * `:data_dir` — the store's directory (default the application's resolved
      `:data_dir`, then `"./data"`); the database is `<data_dir>/functions.db`
  """
  @spec children(keyword()) :: [Supervisor.child_spec()]
  def children(opts \\ []) do
    if enabled?() do
      boot_check!()
      stats_children() ++ bundle_children(opts) ++ pool_children(opts)
    else
      []
    end
  end

  defp stats_children, do: [{EbbServer.Functions.Stats, []}]

  defp bundle_children(opts) do
    case bundle_dir() do
      nil -> store_children(opts)
      dir -> [{BundleCache, loader: DirLoader, loader_opts: [dir: dir]}]
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

  defp pool_children(_opts) do
    if pool?() do
      [
        {Pool,
         [
           size: pool_size(),
           queue_limit: queue_limit(),
           queue_timeout_ms: queue_timeout_ms(),
           transport: transport(),
           transport_opts: worker_opts()
         ]}
      ]
    else
      []
    end
  end

  # A node that says functions are enabled but cannot start a worker is
  # broken now, not on the first invocation. The check runs before any child
  # starts so a container fails its boot instead of serving a route that can
  # only answer 503.
  defp boot_check! do
    if transport() == Bun or pool?() do
      check_executable!(bun_path())
      check_file!(runner_path(), "runner")
    end

    :ok
  end

  defp check_executable!(nil) do
    raise """
    functions are enabled but bun was not found on PATH.

    Install Bun #{bun_version()} (see .bun-version) or set
    `config :ebb_server, :functions, worker_opts: [bun_path: "/path/to/bun"]`.
    Set EBB_FUNCTIONS_ENABLED=false to boot without functions.
    """
  end

  defp check_executable!(path) do
    executable? =
      with true <- is_binary(path),
           {:ok, %File.Stat{mode: mode}} <- File.stat(path) do
        Bitwise.band(mode, 0o111) != 0
      else
        _error -> false
      end

    unless executable? do
      raise """
      functions are enabled but the bun executable is missing or not runnable: #{inspect(path)}.

      Install Bun #{bun_version()} (see .bun-version) or set
      `config :ebb_server, :functions, worker_opts: [bun_path: "/path/to/bun"]`.
      Set EBB_FUNCTIONS_ENABLED=false to boot without functions.
      """
    end
  end

  defp check_file!(path, what) do
    unless is_binary(path) and File.regular?(path) do
      raise """
      functions are enabled but the #{what} file is missing: #{inspect(path)}.

      Build it with `bash scripts/build-runner.sh` (the release image does this
      at build time), or set
      `config :ebb_server, :functions, worker_opts: [runner_path: "/path/to/main.js"]`.
      Set EBB_FUNCTIONS_ENABLED=false to boot without functions.
      """
    end
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
  The admin credential deploy and activation require.

  Resolved at boot from `EBB_FUNCTIONS_ADMIN_TOKEN` first, then `:admin_token`.
  Unset or blank means no admin credential exists, so those routes deny rather
  than open. It is never an invoke grant: see `EbbServer.Functions.Admin`.
  """
  @spec admin_token() :: String.t() | nil
  def admin_token do
    case config(:admin_token) do
      token when is_binary(token) -> blank_to_nil(token)
      _token -> nil
    end
  end

  @doc """
  The configured service credentials, normalized to atom-keyed maps.

  Each entry is `%{id, token_sha256, subject_actor_id, permissions}`.
  `EbbServer.Functions.Principal` is the only reader.
  """
  @spec services() :: [map()]
  def services, do: Keyword.get(config(), :services, [])

  @doc """
  The secrets one function may read, resolved at boot.

  Returns `{:error, {:missing_secret, keys}}` when a configured key had no
  value at boot, so the router can refuse the invocation before a worker is
  spawned. A function with no `:env` entry gets `{:ok, %{}}`.
  """
  @spec invocation_env(String.t()) :: {:ok, map()} | {:error, {:missing_secret, [String.t()]}}
  def invocation_env(name) when is_binary(name) do
    missing = Map.get(Keyword.get(config(), :missing_env, %{}), name, [])

    case missing do
      [] -> {:ok, Map.get(Keyword.get(config(), :resolved_env, %{}), name, %{})}
      keys -> {:error, {:missing_secret, keys}}
    end
  end

  @doc """
  The limits handed to a worker in the invoke frame.

  The runner and the Elixir side each enforce the ones they can: the runner
  refuses an oversize host frame and a call past the host-call budget, while
  the server refuses an oversize request body, an oversize result, and a call
  past the same budget.
  """
  @spec limits() :: map()
  def limits do
    %{
      "max_host_calls" => Keyword.get(config(), :max_host_calls, @default_max_host_calls),
      "max_log_lines" => Keyword.get(config(), :max_log_lines, @default_max_log_lines),
      "max_log_bytes" => Keyword.get(config(), :max_log_bytes, @default_max_log_bytes),
      "max_output_bytes" => max_output_bytes(),
      "fetch_allowlist" => fetch_allowlist()
    }
  end

  @doc "The largest request body an invocation accepts, before the frame bound."
  @spec max_invoke_body_bytes() :: pos_integer()
  def max_invoke_body_bytes do
    Keyword.get(config(), :max_invoke_body_bytes, @default_max_invoke_body_bytes)
  end

  @doc "The largest result a handler may return, in bytes."
  @spec max_output_bytes() :: pos_integer()
  def max_output_bytes do
    Keyword.get(config(), :max_output_bytes, EbbServer.Functions.Protocol.max_frame_bytes())
  end

  @doc "The host-call budget one invocation may spend."
  @spec max_host_calls() :: pos_integer()
  def max_host_calls, do: Keyword.get(config(), :max_host_calls, @default_max_host_calls)

  @doc "The log lines one invocation may emit before the server drops the rest."
  @spec max_log_lines() :: pos_integer()
  def max_log_lines, do: Keyword.get(config(), :max_log_lines, @default_max_log_lines)

  @doc "The log bytes one invocation may emit before the server drops the rest."
  @spec max_log_bytes() :: pos_integer()
  def max_log_bytes, do: Keyword.get(config(), :max_log_bytes, @default_max_log_bytes)

  @doc """
  The hosts a handler's `fetch` may reach, or `[]` for no restriction.

  An empty list is the trusted-author default: egress policy is the control,
  not a wrapper the author can bypass. A non-empty list is a guardrail the
  runner enforces around the global `fetch` and audits per call.
  """
  @spec fetch_allowlist() :: [String.t()]
  def fetch_allowlist do
    case config(:fetch_allowlist) do
      hosts when is_list(hosts) -> Enum.filter(hosts, &is_binary/1)
      _hosts -> []
    end
  end

  @doc """
  The address-space budget (bytes) applied to one Bun worker on Linux.

  This is a **node-wide** cap, not a per-function one: pooled workers are
  spawned before an invocation knows which bundle it will run, so the
  envelope's `memoryBytes` is validated and carried but does not set a v1
  control. The cap is the node budget plus the runtime's own reservation, so
  the OS limit is not a byte-exact JS heap cap. macOS gets no limit: there is
  no portable per-process equivalent the server can set without privileges.
  """
  @spec memory_limit_bytes() :: pos_integer()
  def memory_limit_bytes do
    base = Keyword.get(config(), :memory_bytes, @default_memory_bytes)
    base + @address_space_overhead_bytes
  end

  @doc """
  How many unpinned versions per name retention keeps. Pinned versions and the
  active one are kept in addition to this count.
  """
  @spec retention() :: non_neg_integer()
  def retention, do: Keyword.get(config(), :retention, 20)

  @doc """
  The worker transport module.

  `EbbServer.Functions.Worker.Bun` is the real runner; the in-process
  `Fake` is what unit tests and the directory-loader dev loop use.
  """
  @spec transport() :: module()
  def transport, do: Keyword.get(config(), :transport, Bun)

  @doc """
  Options passed to the transport for every invocation.

  For the Bun transport the defaults are filled in here: the committed runner
  bundle under `priv/`, the `bun` on PATH, and a socket directory under the
  data dir. Anything present in config wins, so a test or a deployment can
  point at another runner without a code change.
  """
  @spec worker_opts() :: keyword()
  def worker_opts do
    configured = Keyword.get(config(), :worker_opts, [])

    case transport() do
      Bun ->
        Keyword.merge(
          [
            runner_path: runner_path(),
            bun_path: bun_path(),
            memory_limit_bytes: memory_limit_bytes()
          ],
          configured
        )

      _other ->
        configured
    end
  end

  @doc """
  Whether invocations go through the pre-warmed worker pool.

  Off when the transport is not the real Bun runner: the fake is scripted per
  invocation and a pooled fake would hand one test's script to another's
  request. A deployment can force it off with `pool: false`.
  """
  @spec pool?() :: boolean()
  def pool? do
    case config(:pool) do
      nil -> transport() == Bun
      value -> value == true and transport() == Bun
    end
  end

  @doc "The number of warm workers the pool keeps, default `min(4, schedulers)`."
  @spec pool_size() :: non_neg_integer()
  def pool_size do
    Keyword.get(config(), :pool_size, min(4, System.schedulers_online()))
  end

  @doc "How many invocations may wait for a worker before the pool answers 503."
  @spec queue_limit() :: non_neg_integer()
  def queue_limit, do: Keyword.get(config(), :queue_limit, @default_queue_limit)

  @doc "How long a checkout may wait in the queue before the pool answers 503."
  @spec queue_timeout_ms() :: pos_integer()
  def queue_timeout_ms, do: Keyword.get(config(), :queue_timeout_ms, @default_queue_timeout_ms)

  @doc "The Bun executable the Bun transport runs."
  @spec bun_path() :: String.t() | nil
  def bun_path do
    Keyword.get(config(:worker_opts) || [], :bun_path) || System.find_executable("bun")
  end

  @doc """
  The runner entrypoint the Bun transport runs.

  Defaults to the committed single-file bundle at
  `priv/runner/main.js`, which `scripts/build-runner.sh` rebuilds from
  `packages/runner`.
  """
  @spec runner_path() :: String.t()
  def runner_path do
    Keyword.get(config(:worker_opts) || [], :runner_path) ||
      Application.app_dir(:ebb_server, "priv/runner/main.js")
  end

  @doc """
  The Bun version this node expects, for the boot failure text.

  Not read from `.bun-version` at compile time: the Docker builder copies the
  app to a path with a different depth, so a relative read would fail there.
  A deployment that needs a different wording can set `:bun_version`.
  """
  @spec bun_version() :: String.t()
  def bun_version do
    Keyword.get(config(), :bun_version, "the version pinned in .bun-version")
  end

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
  defp env_value(name) do
    case System.get_env(name) do
      nil -> nil
      raw -> blank_to_nil(String.trim(raw))
    end
  end

  defp blank_to_nil(value) when is_binary(value) do
    if String.trim(value) == "", do: nil, else: value
  end

  defp blank_to_nil(_value), do: nil

  defp put_resolved(config, key, nil), do: Keyword.delete(config, key)
  defp put_resolved(config, key, value), do: Keyword.put(config, key, value)

  defp resolve_admin_token do
    # One resolution shared with the registry's admin routes:
    # `EBB_ADMIN_TOKEN` / the server-level key first, then the functions
    # environment variable and nested key this deployment may already use.
    Token.resolve_value()
  end

  defp resolve_secrets(config) do
    spec = Keyword.get(config(), :env, %{})
    validate_env!(spec)

    {resolved, missing} =
      Enum.reduce(spec, {%{}, %{}}, fn {name, keys}, {resolved, missing} ->
        {values, absent} = resolve_keys(keys)

        resolved = if map_size(values) == 0, do: resolved, else: Map.put(resolved, name, values)
        missing = if absent == [], do: missing, else: Map.put(missing, name, Enum.reverse(absent))
        {resolved, missing}
      end)

    config
    |> Keyword.put(:resolved_env, resolved)
    |> Keyword.put(:missing_env, missing)
  end

  defp resolve_keys(keys) do
    Enum.reduce(keys, {%{}, []}, fn key, {values, absent} ->
      case System.get_env(key) do
        value when value in [nil, ""] -> {values, [key | absent]}
        value -> {Map.put(values, key, value), absent}
      end
    end)
  end

  defp validate_env!(spec) when is_map(spec) do
    Enum.each(spec, fn
      {name, keys} when is_binary(name) and is_list(keys) ->
        unless Enum.all?(keys, &(is_binary(&1) and &1 != "")) do
          raise ":ebb_server, :functions, env #{inspect(name)} must be a list of " <>
                  "environment variable names, got #{inspect(keys)}"
        end

      other ->
        raise ":ebb_server, :functions, env must map a function name to a list of " <>
                "environment variable names, got #{inspect(other)}"
    end)
  end

  defp validate_env!(other) do
    raise ":ebb_server, :functions, env must be a map, got #{inspect(other)}"
  end

  defp validate_services!(services) when is_list(services) do
    Enum.map(services, &validate_service!/1)
  end

  defp validate_services!(other) do
    raise ":ebb_server, :functions, services must be a list, got #{inspect(other)}"
  end

  defp validate_service!(service) when is_map(service) do
    normalized = %{
      id: fetch_string!(service, :id, "services[].id"),
      token_sha256: fetch_sha256!(service),
      subject_actor_id: fetch_string!(service, :subject_actor_id, "services[].subject_actor_id"),
      permissions: fetch_permissions!(service)
    }

    normalized
  end

  defp validate_service!(other) do
    raise ":ebb_server, :functions, services entries must be maps, got #{inspect(other)}"
  end

  defp fetch_sha256!(service) do
    token = fetch_string!(service, :token_sha256, "services[].token_sha256")

    unless Regex.match?(~r/\A[0-9a-f]{64}\z/, token) do
      raise ":ebb_server, :functions, services[].token_sha256 must be 64 lowercase " <>
              "hex characters (the sha256 of the presented token, not the token itself)"
    end

    token
  end

  defp fetch_permissions!(service) do
    permissions = Map.get(service, :permissions, Map.get(service, "permissions"))

    unless is_list(permissions) and Enum.all?(permissions, &is_binary/1) do
      raise ":ebb_server, :functions, services[].permissions must be a list of strings"
    end

    permissions
  end

  defp fetch_string!(service, key, label) do
    value = Map.get(service, key) || Map.get(service, Atom.to_string(key))

    unless is_binary(value) and value != "" do
      raise ":ebb_server, :functions, #{label} must be a non-empty string, got #{inspect(value)}"
    end

    value
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
