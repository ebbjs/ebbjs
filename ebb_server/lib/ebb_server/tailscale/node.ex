defmodule EbbServer.Tailscale.Node do
  @moduledoc """
  Owns the embedded `ebb_tsnode` gateway and turns its output into logs.

  The gateway is an ordinary executable rather than an Erlang port-protocol
  peer: the BEAM writes one JSON configuration line to its stdin and reads one
  compact JSON object per line back. stderr is folded into stdout, so a Go log
  line arrives as a non-JSON line and is forwarded instead of decoded. The
  contract stays this narrow — the gateway knows only "login is identity" — so
  either half can be replaced without the other.

  Events:

    * `login` — a URL the operator has to visit, logged once per URL;
    * `qr` — the same URL as ASCII lines, printed raw, because a `Logger`
      prefix on every line breaks the block characters a scanner needs;
    * `running` — the node is serving: stored for `status/1` and reported with
      its addresses and the tags Tailscale actually applied;
    * `error` — forwarded as an error line.

  A gateway that exits is restarted with exponential backoff, because the usual
  reason is a control-plane outage the operator cannot act on. The attempt
  counter resets on `running`, so a node that never reaches the tailnet retries
  slowly instead of hammering the control plane.

  The node stops itself when tags were requested, Tailscale applied none of
  them, and `EBB_TAILSCALE_REQUIRE_TAGS` is set. A tagged node is the
  deployment that stays signed in; serving untagged would silently expire.
  """

  use GenServer

  require Logger

  @default_backoff_initial_ms 1_000
  @default_backoff_max_ms 60_000

  # One status line is small; the bound exists so a runaway writer cannot make
  # the BEAM buffer without limit. A longer line arrives as `:noeol` and is
  # dropped rather than mistaken for JSON.
  @max_line_bytes 1_048_576

  @expiry_warning_days 14

  @default_tag "tag:ebb"

  @doc """
  Starts the gateway, writing the initial configuration immediately.

  `:config` is the map `EbbServer.Tailscale.Config.resolve/2` returns, plus the
  `:proxy_secret` the gateway must echo per request. The remaining options are
  test knobs so a suite never needs the environment or a real tailnet:
  `:name` (default `__MODULE__`, `nil` for an anonymous process),
  `:backoff_initial_ms`, `:backoff_max_ms`, and `:spawn_opts` (extra
  `Port.open/2` options).
  """
  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts) do
    {config, opts} = Keyword.pop(opts, :config)

    unless is_map(config) do
      raise ArgumentError,
            "EbbServer.Tailscale.Node needs the resolved tailscale config map as :config"
    end

    GenServer.start_link(__MODULE__, {config, opts}, gen_server_opts(opts))
  end

  @doc false
  # `:transient` is what keeps the `require_tags` stop from hot-looping: a
  # `:permanent` child would be restarted by the supervisor immediately after
  # it stopped on purpose, and a crash still restarts.
  def child_spec(opts) do
    %{
      id: Keyword.get(opts, :name, __MODULE__),
      start: {__MODULE__, :start_link, [opts]},
      restart: :transient
    }
  end

  @doc "The last `running` event, or `nil` before the node has served."
  @spec status(GenServer.server()) :: map() | nil
  def status(server \\ __MODULE__), do: GenServer.call(server, :status)

  @doc "The last login URL the gateway reported, or `nil` while authorized."
  @spec last_login_url(GenServer.server()) :: String.t() | nil
  def last_login_url(server \\ __MODULE__), do: GenServer.call(server, :last_login_url)

  defp gen_server_opts(opts) do
    case Keyword.get(opts, :name, __MODULE__) do
      nil -> []
      name -> [name: name]
    end
  end

  @impl true
  def init({config, opts}) do
    state = %{
      config: config,
      backoff_initial_ms: Keyword.get(opts, :backoff_initial_ms, @default_backoff_initial_ms),
      backoff_max_ms: Keyword.get(opts, :backoff_max_ms, @default_backoff_max_ms),
      spawn_opts: Keyword.get(opts, :spawn_opts, []),
      port: nil,
      status: nil,
      login_url: nil,
      qr_url: nil,
      attempts: 0
    }

    # A binary deleted after boot makes `Port.open/2` raise here; the
    # supervisor's restart policy is the right ceiling for that, and the
    # boot-time check in `Config.resolve/2` already covers the first start.
    {:ok, open(state)}
  end

  @impl true
  def handle_info({port, {:data, {:eol, line}}}, %{port: port} = state) do
    handle_line(line, state)
  end

  # A line past `@max_line_bytes` cannot be a status object; the gateway is
  # free to keep writing, so the fragment is dropped instead of buffered.
  def handle_info({port, {:data, {:noeol, _partial}}}, %{port: port} = state) do
    {:noreply, state}
  end

  def handle_info({port, {:exit_status, status}}, %{port: port} = state) do
    Logger.warning("ebb_tsnode exited with status #{status}")
    {:noreply, schedule_restart(%{state | port: nil})}
  end

  def handle_info(:restart, state), do: {:noreply, open(state)}

  # A message from a port this process no longer owns, such as an exit status
  # that arrives after the restart opened a replacement. Ignoring it is what
  # keeps a late message from triggering a second restart.
  def handle_info(_message, state), do: {:noreply, state}

  @impl true
  def handle_call(:status, _from, state), do: {:reply, state.status, state}

  def handle_call(:last_login_url, _from, state), do: {:reply, state.login_url, state}

  @impl true
  def terminate(_reason, state) do
    stop_child(state.port)
    :ok
  end

  defp open(state) do
    port = Port.open({:spawn_executable, env_path()}, port_options(state))
    send_config(port, state.config)
    %{state | port: port}
  end

  defp env_path, do: System.find_executable("env") || "/usr/bin/env"

  # `env -i` gives the gateway exactly what it needs: tsnet reads HOME for its
  # cache, the proxy resolves nothing else, and the tsnet log upload is
  # suppressed because a self-hosted node should not ship logs to Tailscale.
  defp port_options(state) do
    [
      :binary,
      :exit_status,
      :stderr_to_stdout,
      {:line, @max_line_bytes},
      {:args, env_args() ++ [state.config.proxy_bin]}
    ] ++ state.spawn_opts
  end

  defp env_args do
    [
      "-i",
      "PATH=#{System.get_env("PATH") || "/usr/local/bin:/usr/bin:/bin"}",
      "HOME=#{System.get_env("HOME") || "/tmp"}",
      "LANG=C.UTF-8",
      "TS_NO_LOGS_NO_SUPPORT=1"
    ]
  end

  # The stdin payload is the whole contract with the Go side: string keys, and
  # the empty string instead of `null` for an unset option so the Go side keeps
  # plain string fields.
  defp child_config(config) do
    %{
      "state_dir" => config.state_dir,
      "hostname" => config.hostname,
      "auth_key" => config.auth_key || "",
      "control_url" => config.control_url || "",
      "tags" => config.tags,
      "https" => config.https,
      "backend_addr" => config.backend_addr,
      "proxy_secret" => Map.get(config, :proxy_secret) || "",
      "qr" => config.qr
    }
  end

  # A gateway that is already dying may close before the write lands; its exit
  # status is queued either way, so a refused write is not worth crashing over.
  defp send_config(port, config) do
    Port.command(port, [Jason.encode!(child_config(config)), "\n"])
  rescue
    ArgumentError -> :error
  end

  defp handle_line(line, state) do
    case Jason.decode(line) do
      {:ok, %{"event" => "login", "url" => url}} when is_binary(url) -> login(url, state)
      {:ok, %{"event" => "qr", "url" => url} = event} when is_binary(url) -> qr(event, state)
      {:ok, %{"event" => "running"} = status} -> running(status, state)
      {:ok, %{"event" => "error"} = event} -> error(event, state)
      _not_a_status_event -> forward(line, state)
    end
  end

  # The URL is the one thing the operator needs from a stalled node, so it is
  # logged once per distinct URL: a retrying gateway republishes the same one.
  defp login(url, %{login_url: url} = state), do: {:noreply, state}

  defp login(url, state) do
    Logger.info("tailscale login required: #{url}")
    {:noreply, %{state | login_url: url}}
  end

  defp qr(%{"url" => url}, %{qr_url: url} = state), do: {:noreply, state}

  defp qr(%{"url" => url} = event, state) do
    if state.config.qr, do: print_qr(event)
    {:noreply, %{state | qr_url: url}}
  end

  # Raw output, deliberately not `Logger`: a per-line prefix would destroy the
  # QR the operator is meant to scan from `docker logs`.
  defp print_qr(event) do
    event
    |> Map.get("lines", [])
    |> Enum.each(&IO.puts/1)
  end

  defp running(status, state) do
    Logger.info(serving_message(status))
    state = %{state | status: status, attempts: 0}

    # Key expiry is independent of tags: an untagged node always has one, and a
    # tagged node can still be given an expiring key.
    expiry_warning(status)

    case tag_verdict(state.config, status) do
      :stop -> {:stop, :normal, state}
      :ok -> {:noreply, state}
    end
  end

  defp serving_message(status) do
    "tailscale node is serving #{serving_url(status)} " <>
      "(ips: #{list_text(status["ips"])}, tls: #{tls_text(status)}, " <>
      "tags: #{list_text(status["tags"])})"
  end

  defp serving_url(status), do: status["url"] || "https://#{status["dns_name"]}"

  defp list_text(values) when is_list(values) and values != [], do: Enum.join(values, ",")

  defp list_text(_empty), do: "none"

  defp tls_text(status), do: if(status["tls"] == true, do: "on", else: "off")

  # Tailscale fixes a node's tags at first login. A tag the authorizing user
  # cannot apply, or one that is not in the policy, leaves the node untagged:
  # which of those happened is only visible here, after the fact.
  defp tag_verdict(config, status) do
    requested = config.tags
    applied = applied_tags(status)

    cond do
      requested != [] and not Enum.any?(requested, &(&1 in applied)) ->
        warn_tags_not_applied(config, requested, applied)

      applied == [] ->
        warn_untagged(status)
        :ok

      true ->
        :ok
    end
  end

  defp applied_tags(status) do
    case status["tags"] do
      tags when is_list(tags) -> tags
      _absent -> []
    end
  end

  defp warn_tags_not_applied(config, requested, applied) do
    message =
      "tailscale node did not apply the requested tags #{inspect(requested)} " <>
        "(applied: #{inspect(applied)}). A tag the authorizing user cannot apply, or " <>
        "one missing from the policy, registers the node untagged and expiring. Add the " <>
        "tag to the tailnet policy: #{tag_owners_snippet(hd(requested))}. Tags are fixed " <>
        "at first login, so re-authenticate the node for a changed list to take effect."

    if config.require_tags do
      Logger.error(message <> " EBB_TAILSCALE_REQUIRE_TAGS is set, so the gateway is stopping.")
      :stop
    else
      Logger.warning(message)
      :ok
    end
  end

  defp warn_untagged(status) do
    Logger.warning(
      "tailscale node is untagged, so its key expires #{expiry_text(status)}. " <>
        "Tag the node to stay signed in without operator attention: " <>
        tag_owners_snippet(@default_tag)
    )
  end

  defp tag_owners_snippet(tag) do
    ~s("tagOwners": { "#{tag}": ["autogroup:admin"] })
  end

  defp expiry_text(status) do
    case status["key_expiry"] do
      expiry when is_binary(expiry) -> "on #{expiry}"
      _unknown -> "at an unknown time (key expiry unknown)"
    end
  end

  defp expiry_warning(status) do
    with expiry when is_binary(expiry) <- status["key_expiry"],
         {:ok, expires_at, _offset} <- DateTime.from_iso8601(expiry),
         days = DateTime.diff(expires_at, DateTime.utc_now(), :day),
         true <- days <= @expiry_warning_days do
      Logger.warning(
        "tailscale node key expires on #{expiry}, within #{@expiry_warning_days} days. " <>
          "Tag the node or renew the key before it is removed from the tailnet."
      )
    end

    :ok
  end

  defp error(event, state) do
    Logger.error("ebb_tsnode: #{event["message"] || Jason.encode!(event)}")
    {:noreply, state}
  end

  defp forward(line, state) do
    # The Go side prefixes its own lines; tsnet's `UserLogf` lines arrive bare.
    if String.starts_with?(line, "ebb_tsnode: ") do
      Logger.warning(line)
    else
      Logger.warning("ebb_tsnode: #{line}")
    end

    {:noreply, state}
  end

  defp schedule_restart(state) do
    attempts = state.attempts + 1
    delay = min(state.backoff_initial_ms * Integer.pow(2, attempts - 1), state.backoff_max_ms)

    Logger.warning("ebb_tsnode restarting in #{delay}ms (attempt #{attempts})")
    Process.send_after(self(), :restart, delay)

    %{state | attempts: attempts}
  end

  # Closing the port closes the gateway's stdin, which is its shutdown signal.
  # The kill is the backstop for a gateway that is already wedged; the OS pid
  # has to be read before the port is gone.
  defp stop_child(nil), do: :ok

  defp stop_child(port) do
    os_pid = port_os_pid(port)
    close_port(port)
    if os_pid, do: kill_os_process(os_pid)
    :ok
  end

  defp port_os_pid(port) do
    with {:os_pid, os_pid} <- Port.info(port, :os_pid), do: os_pid
  end

  defp close_port(port) do
    Port.close(port)
  rescue
    ArgumentError -> :ok
  end

  defp kill_os_process(os_pid) do
    _ = System.cmd("kill", ["-9", to_string(os_pid)], stderr_to_stdout: true)
    :ok
  end
end
