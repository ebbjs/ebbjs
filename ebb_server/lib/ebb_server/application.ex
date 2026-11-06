defmodule EbbServer.Application do
  @moduledoc false

  require Logger

  use Application

  alias EbbServer.Tailscale

  @impl true
  def start(_type, _args) do
    data_dir = runtime_data_dir()
    port = runtime_port()
    {auth_mode, auth_url} = resolve_auth!()

    Application.put_env(:ebb_server, :auth_mode, auth_mode)
    Application.put_env(:ebb_server, :auth_url, auth_url)

    # Resolved before `validate_tailscale_secret!/1` and before Bandit can serve
    # a request: the embedded node's secret is minted here.
    gateway_children =
      if auth_mode == :tailscale, do: resolve_tailscale!(data_dir, port), else: []

    validate_tailscale_secret!(auth_mode)

    # The promoted admin credential is resolved before functions, which use it
    # for their deploy routes, and before any listener accepts a request.
    resolve_admin!()

    # Resolved once, before `children/0` reads it and before Bandit can serve
    # the route: `enabled?/0` must not consult the environment per request.
    resolve_functions!()

    if auth_mode == :bypass do
      Logger.warning(
        "auth mode :bypass is active: any client can claim any actor identity via the " <>
          "x-ebb-actor-id header. Never expose this node publicly; set EBB_AUTH_MODE=external " <>
          "and EBB_AUTH_URL for real deployments."
      )
    end

    if auth_mode == :tailscale do
      Logger.info(
        "auth mode :tailscale is active: trusting `tailscale-user-login` only from " <>
          "loopback peers and binding Bandit to 127.0.0.1. " <> tailscale_secret_message()
      )
    end

    # After Bandit: the gateway only starts serving once the tailnet node is
    # running, so the backend listener exists before any proxied request.
    children =
      [
        {EbbServer.Storage.Supervisor, [data_dir: data_dir]}
      ] ++
        functions_children(data_dir) ++
        [
          EbbServer.Telemetry.Sampler,
          {Registry, keys: :unique, name: EbbServer.Sync.GroupRegistry},
          EbbServer.Sync.Supervisor,
          # Attached before Bandit so every request Bandit accepts is sampled.
          EbbServer.Telemetry.HTTP,
          {Bandit, bandit_options(port, auth_mode)}
        ] ++
        gateway_children ++ action_export_children()

    opts = [strategy: :one_for_one, name: EbbServer.Supervisor]
    Supervisor.start_link(children, opts)
  end

  # `:tailscale` trusts identity headers that any local process could write, so
  # the listener must be reachable only through the gateway that injects them.
  # The `remote_ip` check in `AuthPlug` is the enforcement; binding loopback is
  # defence in depth. Every other mode keeps Bandit's default (all interfaces).
  @doc false
  @spec bind_ip(atom()) :: :any | :inet.ip_address()
  def bind_ip(:tailscale), do: {127, 0, 0, 1}
  def bind_ip(_mode), do: :any

  # Resolves the node and, for the embedded mode, mints the proxy secret
  # `AuthPlug` requires. Returns the children to start after Bandit.
  @doc false
  @spec resolve_tailscale!(String.t(), integer()) :: [Supervisor.child_spec()]
  def resolve_tailscale!(data_dir, port) do
    config = Tailscale.Config.resolve(data_dir, port)

    case config.node do
      :external ->
        # `tailscale serve` or a sidecar owns the node. It cannot inject a
        # per-request secret, so loopback stays the only credential and this
        # server mints none.
        Logger.info(
          "tailscale node mode: external " <>
            "(no gateway child; another process in front of this server injects identity)"
        )

        []

      :embedded ->
        # AuthPlug reads the secret per request, so it has to exist before
        # Bandit starts. This runs while `start/2` builds the child list, which
        # is before the supervisor, the listener, and any request.
        config = prepare_state_dir!(config)
        secret = proxy_secret!()
        Application.put_env(:ebb_server, :tailscale_proxy_secret, secret)
        Logger.info("tailscale node mode: embedded (gateway child starts after Bandit)")

        [{Tailscale.Node, [config: Map.put(config, :proxy_secret, secret)]}]
    end
  rescue
    # Same reason as `resolve_auth!/0`: a release whose `start/2` raises is
    # reported as a generic shutdown and loses the actionable message.
    error in RuntimeError ->
      IO.puts(:stderr, "ebb_server boot failed: #{Exception.message(error)}")
      reraise error, __STACKTRACE__
  end

  # tsnet creates and writes the state directory itself, but a path it cannot
  # create or write (a read-only volume, a file in the way) would surface only
  # as a gateway that dies on every start. Failing here names the setting.
  defp prepare_state_dir!(config) do
    with :ok <- File.mkdir_p(config.state_dir),
         :ok <- probe_write(config.state_dir) do
      config
    else
      {:error, reason} ->
        raise "EBB_TAILSCALE_STATE_DIR=#{inspect(config.state_dir)} cannot be created or " <>
                "written: #{:file.format_error(reason)}"
    end
  end

  # `mkdir_p/1` reports `:ok` for a directory that already exists, writable or
  # not, and tsnet writes its state and log policy here on start.
  defp probe_write(dir) do
    path = Path.join(dir, ".write-probe-#{System.unique_integer([:positive])}")

    case File.write(path, "") do
      :ok ->
        _ = File.rm(path)
        :ok

      {:error, _reason} = error ->
        error
    end
  end

  # A secret already in the application env belongs to the operator or to a
  # test, including a bad one: boot fails rather than minting a replacement
  # that would silently change what every request has to carry.
  defp proxy_secret! do
    case Application.get_env(:ebb_server, :tailscale_proxy_secret) do
      nil ->
        :crypto.strong_rand_bytes(32) |> Base.url_encode64(padding: false)

      secret ->
        validate_tailscale_secret!(:tailscale, secret)
        secret
    end
  end

  # Exposed so a test can boot the same listener the application builds and
  # assert the address it actually binds, not just the pure `bind_ip/1` answer.
  @doc false
  @spec bandit_options(integer(), atom()) :: keyword()
  def bandit_options(port, auth_mode) do
    base = [plug: EbbServer.Sync.Router, port: port]

    case bind_ip(auth_mode) do
      :any -> base
      ip -> [{:ip, ip} | base]
    end
  end

  # The secret is either absent (the `tailscale serve` path, where loopback is
  # the only credential) or a non-empty string the gateway echoes per request.
  # Anything else is an operator or integration error that would otherwise
  # reject every request with an indistinguishable 401, so it fails at boot.
  @doc false
  @spec validate_tailscale_secret!(atom(), term()) :: :ok
  def validate_tailscale_secret!(
        auth_mode,
        secret \\ Application.get_env(:ebb_server, :tailscale_proxy_secret)
      )

  def validate_tailscale_secret!(:tailscale, nil), do: :ok

  def validate_tailscale_secret!(:tailscale, secret) when is_binary(secret) and secret != "",
    do: :ok

  def validate_tailscale_secret!(:tailscale, other) do
    raise ":ebb_server, :tailscale_proxy_secret must be a non-empty string when set, " <>
            "got #{inspect(other)}"
  end

  def validate_tailscale_secret!(_mode, _secret), do: :ok

  defp tailscale_secret_message do
    case Application.get_env(:ebb_server, :tailscale_proxy_secret) do
      secret when is_binary(secret) and secret != "" ->
        "Requests must also carry the configured x-ebb-tailscale-secret header."

      _unset ->
        "No proxy secret is configured, so any process on this host can claim an " <>
          "identity by sending the header. Configure :tailscale_proxy_secret."
    end
  end

  # The exporter is opt-in: without a configured handler it is never
  # started, so an unconfigured node pays nothing for the feature.
  @doc false
  @spec action_export_children() :: [Supervisor.child_spec()]
  def action_export_children do
    if Application.get_env(:ebb_server, :on_action) do
      [EbbServer.ActionExport.Supervisor]
    else
      []
    end
  end

  # The functions store and bundle cache are opt-in: `children/1` is `[]` when
  # the flag is off, the store then the cache when versions live in SQLite, or
  # the cache alone over `:bundle_dir`. The data dir is the one the node
  # resolved once, so the functions database always sits beside the others.
  defp functions_children(data_dir), do: EbbServer.Functions.children(data_dir: data_dir)

  defp resolve_functions! do
    EbbServer.Functions.resolve!()
  rescue
    error in RuntimeError ->
      IO.puts(:stderr, "ebb_server boot failed: #{Exception.message(error)}")
      reraise error, __STACKTRACE__
  end

  defp resolve_admin! do
    EbbServer.Admin.Token.resolve!()
  rescue
    error in RuntimeError ->
      IO.puts(:stderr, "ebb_server boot failed: #{Exception.message(error)}")
      reraise error, __STACKTRACE__
  end

  # Resolution order for the storage data directory:
  #   1. `Application.get_env(:ebb_server, :data_dir)` (set by `config/*.exs`)
  #   2. `EBB_DATA_DIR` environment variable (set by containerized deployments)
  #   3. `./data` (the historical default for `mix run`)
  #
  # The application env is checked first so that `MIX_ENV=test mix test`
  # honors the path declared in `config/test.exs` instead of leaking test
  # state into `./data` at the project root.
  defp runtime_data_dir do
    Application.get_env(:ebb_server, :data_dir) || System.get_env("EBB_DATA_DIR") || "./data"
  end

  @doc false
  def runtime_port do
    case {Application.get_env(:ebb_server, :port), parse_env_port()} do
      {port, _} when is_integer(port) ->
        port

      {_, port} when is_integer(port) ->
        port

      _ ->
        4000
    end
  end

  # A release whose `start/2` raises exits with a generic "Runtime
  # terminating during boot" message and loses the exception text. Write
  # the reason to stderr synchronously before re-raising so a container
  # operator sees which variable is missing and which values it accepts.
  defp resolve_auth! do
    runtime_auth()
  rescue
    error in RuntimeError ->
      IO.puts(:stderr, "ebb_server boot failed: #{Exception.message(error)}")
      reraise error, __STACKTRACE__
  end

  @auth_modes %{"bypass" => :bypass, "external" => :external, "tailscale" => :tailscale}
  @auth_mode_names @auth_modes |> Map.keys() |> Enum.join(", ")

  # Auth resolution deliberately reverses the precedence used above for
  # the data directory and port: the environment variable wins over
  # `Application.get_env/2`. Auth is security-sensitive, so the
  # operator's runtime instruction must not be silently overridden by a
  # compiled config baked into a release.
  #
  # There is no default. A release booted without either source refuses
  # to start rather than falling back to `:bypass`, because a silent
  # bypass lets any client forge an actor identity. `:external` also
  # requires a URL here; `EbbServer.Sync.AuthPlug` keeps its request-time
  # 500 as a defensive path for config mutated after boot. `:tailscale` also
  # takes no URL: its identity comes from headers on loopback.
  @doc false
  @spec runtime_auth() :: {:bypass | :external | :tailscale, String.t() | nil}
  def runtime_auth do
    mode = auth_mode()
    {mode, auth_url(mode)}
  end

  defp auth_mode do
    case env_over_app("EBB_AUTH_MODE", :auth_mode) do
      nil ->
        raise "EBB_AUTH_MODE is not set and :ebb_server, :auth_mode has no compiled value. " <>
                "Set EBB_AUTH_MODE to one of: #{@auth_mode_names}."

      raw ->
        case normalize_auth_mode(raw) do
          {:ok, mode} ->
            mode

          :error ->
            raise "EBB_AUTH_MODE must be one of: #{@auth_mode_names}; " <>
                    "got #{inspect(raw)}"
        end
    end
  end

  defp auth_url(:bypass), do: nil

  defp auth_url(:tailscale), do: nil

  defp auth_url(:external) do
    case env_over_app("EBB_AUTH_URL", :auth_url) do
      nil ->
        raise "EBB_AUTH_URL is required when EBB_AUTH_MODE=external. " <>
                "Point it at the identity service that issues actor IDs."

      url ->
        url
    end
  end

  defp normalize_auth_mode(mode) when is_atom(mode) do
    if mode in Map.values(@auth_modes), do: {:ok, mode}, else: :error
  end

  defp normalize_auth_mode(mode) when is_binary(mode) do
    case Map.fetch(@auth_modes, mode) do
      {:ok, atom} -> {:ok, atom}
      :error -> :error
    end
  end

  defp normalize_auth_mode(_mode), do: :error

  # Blank values are treated as unset so an unfilled compose variable
  # cannot select a mode by accident.
  defp env_over_app(env_key, app_key) do
    case normalize_value(System.get_env(env_key)) do
      nil -> normalize_value(Application.get_env(:ebb_server, app_key))
      value -> value
    end
  end

  defp normalize_value(nil), do: nil

  defp normalize_value(value) when is_binary(value),
    do: if(String.trim(value) == "", do: nil, else: value)

  defp normalize_value(value), do: value

  defp parse_env_port do
    case System.get_env("EBB_PORT") do
      nil ->
        nil

      raw ->
        case Integer.parse(raw) do
          {port, ""} -> port
          _ -> raise "EBB_PORT must be an integer, got #{inspect(raw)}"
        end
    end
  end
end
