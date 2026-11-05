defmodule EbbServer.Tailscale.Config do
  @moduledoc """
  Boot-time configuration for the Tailscale node.

  `resolve/2` reads one `EBB_TAILSCALE_*` variable per setting, falling back to
  the matching `:ebb_server` application key and then to the default below.
  The environment wins, in the order `EbbServer.Application.runtime_auth/0`
  uses for security-sensitive settings: the operator's runtime instruction must
  not be silently overridden by a value baked into a release.

  | Variable                    | App key                    | Default                         |
  | --------------------------- | -------------------------- | ------------------------------- |
  | `EBB_TAILSCALE_NODE`        | `:tailscale_node`          | `:embedded`                     |
  | `EBB_TAILSCALE_STATE_DIR`   | `:tailscale_state_dir`     | `<data_dir>/tailscale`          |
  | `EBB_TAILSCALE_HOSTNAME`    | `:tailscale_hostname`      | `ebb`                           |
  | `EBB_TAILSCALE_AUTHKEY`     | `:tailscale_authkey`       | unset                           |
  | `EBB_TAILSCALE_CONTROL_URL` | `:tailscale_control_url`   | unset                           |
  | `EBB_TAILSCALE_TAGS`        | `:tailscale_tags`          | `[]`                            |
  | `EBB_TAILSCALE_REQUIRE_TAGS`| `:tailscale_require_tags`  | `false`                         |
  | `EBB_TAILSCALE_HTTPS`       | `:tailscale_https`         | `auto`                          |
  | `EBB_TAILSCALE_QR`          | `:tailscale_qr`            | `true`                          |
  | `EBB_TAILSCALE_PROXY_BIN`   | `:tailscale_proxy_bin`     | `priv/tsnode/ebb_tsnode`        |

  Blank values count as unset, so an unfilled compose variable cannot select a
  mode by accident. Every accepted value is checked here and raises with an
  operator-facing message: a node that cannot serve its tailnet is a boot
  failure, not a request-time surprise.

  The result is a plain map rather than a struct. It is handed to
  `EbbServer.Tailscale.Node`, which writes most of it to the gateway's stdin,
  and adding a setting must not require a second definition to stay in step.
  """

  @node_modes %{"embedded" => :embedded, "external" => :external}
  @https_modes %{"auto" => "auto", "on" => "on", "off" => "off"}
  @node_names "embedded, external"
  @https_names "auto, on, off"

  @truthy ~w(true 1 yes on)
  @falsy ~w(false 0 no off)

  @default_node :embedded
  @default_hostname "ebb"
  @default_https "auto"
  @default_proxy_bin "priv/tsnode/ebb_tsnode"

  # Tailscale tag names are DNS-label-like and always prefixed; a value that
  # does not match is a typo that would otherwise register the node untagged.
  @tag_format ~r/\Atag:[A-Za-z0-9][A-Za-z0-9-]*\z/

  # tsnet uses the hostname as the MagicDNS label, so it has to be one. Control
  # rejects anything else asynchronously, which the BEAM would see as a gateway
  # that fails on every start rather than as a bad setting.
  @hostname_format ~r/\A[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\z/

  @doc """
  Resolves every setting, raising on a value the gateway cannot use.

  `data_dir` is the node's resolved storage directory, used only to place the
  default state directory; `port` is the Bandit port the gateway proxies to.
  """
  @spec resolve(String.t(), integer()) :: map()
  def resolve(data_dir, port) do
    config = %{
      node: resolve_node(),
      state_dir:
        resolve_string(
          "EBB_TAILSCALE_STATE_DIR",
          :tailscale_state_dir,
          Path.join(data_dir, "tailscale")
        ),
      hostname: resolve_string("EBB_TAILSCALE_HOSTNAME", :tailscale_hostname, @default_hostname),
      auth_key: resolve_string("EBB_TAILSCALE_AUTHKEY", :tailscale_authkey, nil),
      control_url: resolve_string("EBB_TAILSCALE_CONTROL_URL", :tailscale_control_url, nil),
      tags: resolve_tags(),
      require_tags: resolve_boolean("EBB_TAILSCALE_REQUIRE_TAGS", :tailscale_require_tags, false),
      https: resolve_https(),
      qr: resolve_boolean("EBB_TAILSCALE_QR", :tailscale_qr, true),
      proxy_bin: resolve_proxy_bin(),
      backend_addr: "127.0.0.1:#{port}"
    }

    check_embedded!(config)

    config
  end

  # Only the embedded node is configured by this server: the external mode
  # leaves the node to the operator's `tailscale serve` or sidecar, and this
  # server is only the backend. Failing at boot beats a container that serves
  # nothing while its logs claim tailscale mode.
  defp check_embedded!(%{node: :external}), do: :ok

  defp check_embedded!(config) do
    check_hostname!(config.hostname)
    check_proxy_bin!(config)
  end

  defp check_hostname!(hostname) do
    if Regex.match?(@hostname_format, hostname) do
      :ok
    else
      raise "EBB_TAILSCALE_HOSTNAME must be a DNS label (letters, digits, and " <>
              "hyphens, at most 63 characters, no leading or trailing hyphen); " <>
              "got #{inspect(hostname)}"
    end
  end

  defp check_proxy_bin!(%{node: :embedded, proxy_bin: path}) do
    if executable?(path) do
      :ok
    else
      raise """
      EBB_TAILSCALE_NODE=embedded but the gateway binary is missing or not executable:
      #{inspect(path)}

      Build it with `bash scripts/build-tsnode.sh` (the release image does this at
      build time), point EBB_TAILSCALE_PROXY_BIN at an executable, or set
      EBB_TAILSCALE_NODE=external when another process already fronts this server.
      """
    end
  end

  defp executable?(path) do
    with true <- is_binary(path),
         {:ok, %File.Stat{type: :regular, mode: mode}} <- File.stat(path) do
      Bitwise.band(mode, 0o111) != 0
    else
      _missing -> false
    end
  end

  defp resolve_node do
    raw = env_over_app("EBB_TAILSCALE_NODE", :tailscale_node)

    case raw && choice_key(raw) do
      nil -> @default_node
      mode -> Map.get(@node_modes, mode) || invalid_node!(raw)
    end
  end

  defp invalid_node!(raw) do
    raise "EBB_TAILSCALE_NODE must be one of: #{@node_names}; got #{inspect(raw)}"
  end

  defp resolve_https do
    raw = env_over_app("EBB_TAILSCALE_HTTPS", :tailscale_https)

    case raw && choice_key(raw) do
      nil -> @default_https
      mode -> Map.get(@https_modes, mode) || invalid_https!(raw)
    end
  end

  defp invalid_https!(raw) do
    raise "EBB_TAILSCALE_HTTPS must be one of: #{@https_names}; got #{inspect(raw)}"
  end

  # Atoms are a convenience for `config/*.exs`; every choice is compared as a
  # trimmed lowercase string so `:embedded`, `"embedded"` and `" Embedded "`
  # mean the same thing.
  defp choice_key(value) when is_atom(value), do: value |> Atom.to_string() |> String.downcase()
  defp choice_key(value) when is_binary(value), do: value |> String.trim() |> String.downcase()
  defp choice_key(value), do: value

  defp resolve_string(env_key, app_key, default) do
    case env_over_app(env_key, app_key) do
      nil -> default
      value when is_binary(value) -> value
      other -> raise "#{env_key} must be a string, got #{inspect(other)}"
    end
  end

  defp resolve_boolean(env_key, app_key, default) do
    case env_over_app(env_key, app_key) do
      nil -> default
      true -> true
      false -> false
      raw -> parse_boolean!(raw, env_key)
    end
  end

  defp parse_boolean!(raw, source) do
    case raw |> to_string() |> String.trim() |> String.downcase() do
      flag when flag in @truthy -> true
      flag when flag in @falsy -> false
      _invalid -> raise "#{source} must be #{accepted_flags()}, got #{inspect(raw)}"
    end
  end

  defp accepted_flags, do: Enum.join(@truthy ++ @falsy, ", ")

  defp resolve_tags do
    case env_over_app("EBB_TAILSCALE_TAGS", :tailscale_tags) do
      nil -> []
      raw -> parse_tags!(raw)
    end
  end

  defp parse_tags!(raw) do
    tags =
      case raw do
        value when is_binary(value) -> String.split(value, ~r/[\s,]+/, trim: true)
        value when is_list(value) -> value
        value -> raise tags_message(value)
      end

    Enum.map(tags, fn tag ->
      if is_binary(tag) and Regex.match?(@tag_format, tag),
        do: tag,
        else: raise(tags_message(raw))
    end)
  end

  defp tags_message(raw) do
    "EBB_TAILSCALE_TAGS must be a comma or whitespace separated list of tag names " <>
      "such as \"tag:ebb\", got #{inspect(raw)}"
  end

  defp resolve_proxy_bin do
    resolve_string(
      "EBB_TAILSCALE_PROXY_BIN",
      :tailscale_proxy_bin,
      Application.app_dir(:ebb_server, @default_proxy_bin)
    )
  end

  # Blank values are treated as unset so an unfilled compose variable cannot
  # select a mode, a tag, or a hostname by accident. Mirrors the resolution
  # `EbbServer.Application` uses for the data directory and the auth mode.
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
end
