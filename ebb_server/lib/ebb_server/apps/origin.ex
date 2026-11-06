defmodule EbbServer.Apps.Origin do
  @moduledoc """
  The canonical form of a browser origin, and the matching rules the CORS plug
  and the app registry share.

  An origin is a scheme, host and port and nothing else: browsers send it as
  `Origin: https://app.example.com`, never with a path, query or fragment.
  `normalize/1` decides what is registrable and renders it canonically, so a
  stored origin is always comparable string-for-string.

  ## Canonical form

    * only `http` and `https`; the scheme and host are lowercased
    * the scheme's default port is dropped (`:443` for https, `:80` for http),
      any other explicit port is kept
    * IPv6 hosts keep the bracket form
    * no userinfo, query, fragment, or path other than empty or `/`

  ## Wildcards

  The only wildcard is a whole leading host label: `https://*.example.com`,
  optionally with a port. It matches any non-empty subdomain of `example.com`
  under the same scheme and effective port, but not `example.com` itself. A
  bare `*` is not an origin and is never accepted; admitting every origin is a
  policy decision (`EBB_CORS_ALLOW_ANY`), not a registration.

  Wildcard patterns are for matching only. An origin that contains a wildcard
  never matches anything, so a pattern cannot be nested inside another.
  """

  @type canonical :: String.t()
  @type parts :: %{scheme: String.t(), host: String.t(), port: non_neg_integer()}

  @schemes %{"http" => 80, "https" => 443}
  @wildcard_prefix "*."
  @label ~r/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/
  @max_host_bytes 253
  @max_label_bytes 63

  @doc """
  Renders a registrable origin in canonical form.

  ## Examples

      iex> Origin.normalize("HTTPS://App.Example.com:443/")
      {:ok, "https://app.example.com"}

      iex> Origin.normalize("https://app.example.com/path")
      {:error, :invalid_origin}

      iex> Origin.normalize("*")
      {:error, :invalid_origin}
  """
  @spec normalize(term()) :: {:ok, canonical()} | {:error, :invalid_origin}
  def normalize(origin) when is_binary(origin) do
    with {:ok, parts} <- parse(origin) do
      {:ok, render(parts)}
    end
  end

  def normalize(_origin), do: {:error, :invalid_origin}

  @doc """
  Canonicalizes a non-empty list of origins, rejecting repeats after
  normalization.

  The registry admits an origin once, so the same value twice — including two
  spellings of one canonical origin — is a conflict rather than a duplicate
  entry.

  ## Examples

      iex> Origin.normalize_all(["HTTPS://A.example.com:443", "http://b.example.com"])
      {:ok, ["https://a.example.com", "http://b.example.com"]}

      iex> Origin.normalize_all(["https://a.example.com", "https://A.example.com"])
      {:error, :duplicate_origin}
  """
  @spec normalize_all(term()) ::
          {:ok, [canonical()]} | {:error, :invalid_origin | :duplicate_origin}
  def normalize_all(origins) when is_list(origins) and origins != [] do
    origins
    |> Enum.reduce_while({:ok, []}, fn raw, {:ok, acc} ->
      case add_canonical(raw, acc) do
        {:ok, acc} -> {:cont, {:ok, acc}}
        {:error, reason} -> {:halt, {:error, reason}}
      end
    end)
    |> case do
      {:ok, origins} -> {:ok, Enum.reverse(origins)}
      {:error, reason} -> {:error, reason}
    end
  end

  def normalize_all(_origins), do: {:error, :invalid_origin}

  @doc """
  Returns whether `origin` is admitted by `pattern`.

  Both sides are canonicalized here, so a caller may pass raw request input.
  Anything unparsable is `false` rather than an error: an origin that cannot be
  named cannot be matched.

  ## Examples

      iex> Origin.match?("https://a.example.com", "https://*.example.com")
      true

      iex> Origin.match?("https://example.com", "https://*.example.com")
      false
  """
  @spec match?(term(), term()) :: boolean()
  def match?(origin, pattern) when is_binary(origin) and is_binary(pattern) do
    with {:ok, origin_parts} <- parse(origin),
         {:ok, pattern_parts} <- parse(pattern),
         false <- wildcard_host?(origin_parts.host) do
      cond do
        origin_parts == pattern_parts -> true
        wildcard_host?(pattern_parts.host) -> wildcard_match?(origin_parts, pattern_parts)
        true -> false
      end
    else
      _ -> false
    end
  end

  def match?(_origin, _pattern), do: false

  @doc """
  Returns whether a canonical origin carries a wildcard host label.

  ## Examples

      iex> Origin.wildcard?("https://*.example.com")
      true

      iex> Origin.wildcard?("https://example.com")
      false
  """
  @spec wildcard?(term()) :: boolean()
  def wildcard?(origin) when is_binary(origin) do
    case parse(origin) do
      {:ok, parts} -> wildcard_host?(parts.host)
      {:error, :invalid_origin} -> false
    end
  end

  def wildcard?(_origin), do: false

  defp parse(raw) do
    raw = String.trim(raw)

    with :ok <- reject_null(raw),
         {:ok, uri} <- new_uri(raw),
         {:ok, scheme} <- scheme(uri),
         :ok <- reject_userinfo(uri),
         :ok <- reject_query_and_fragment(uri),
         :ok <- accept_path(uri),
         {:ok, host} <- host(uri.host),
         {:ok, port} <- port(uri, scheme) do
      {:ok, %{scheme: scheme, host: host, port: port}}
    else
      _ -> {:error, :invalid_origin}
    end
  end

  defp reject_null(""), do: :error
  defp reject_null(raw), do: if(String.downcase(raw) == "null", do: :error, else: :ok)

  defp new_uri(raw) do
    URI.new(raw)
  rescue
    _ -> {:error, :invalid_origin}
  end

  defp scheme(%URI{scheme: scheme}) when is_binary(scheme) do
    case Map.fetch(@schemes, String.downcase(scheme)) do
      {:ok, _default_port} -> {:ok, String.downcase(scheme)}
      :error -> {:error, :invalid_origin}
    end
  end

  defp scheme(_uri), do: {:error, :invalid_origin}

  defp reject_userinfo(%URI{userinfo: nil}), do: :ok
  defp reject_userinfo(_uri), do: {:error, :invalid_origin}

  defp reject_query_and_fragment(%URI{query: nil, fragment: nil}), do: :ok
  defp reject_query_and_fragment(_uri), do: {:error, :invalid_origin}

  defp accept_path(%URI{path: path}) when path in [nil, "", "/"], do: :ok
  defp accept_path(_uri), do: {:error, :invalid_origin}

  defp host(nil), do: {:error, :invalid_origin}

  defp host(raw_host) do
    raw_host
    |> String.downcase()
    |> canonical_host()
  end

  defp canonical_host(""), do: {:error, :invalid_origin}
  defp canonical_host("*"), do: {:error, :invalid_origin}

  defp canonical_host(host) do
    cond do
      String.contains?(host, ":") -> ipv6_host(host)
      String.starts_with?(host, @wildcard_prefix) -> wildcard_suffix(host)
      String.contains?(host, "*") -> {:error, :invalid_origin}
      valid_dns_host?(host) -> {:ok, host}
      true -> {:error, :invalid_origin}
    end
  end

  defp wildcard_suffix(host) do
    suffix = String.replace_prefix(host, @wildcard_prefix, "")

    if valid_dns_host?(suffix) do
      {:ok, @wildcard_prefix <> suffix}
    else
      {:error, :invalid_origin}
    end
  end

  defp ipv6_host(host) do
    case :inet.parse_address(String.to_charlist(host)) do
      {:ok, address} when tuple_size(address) == 8 ->
        {:ok, "[" <> to_string(:inet.ntoa(address)) <> "]"}

      _ ->
        {:error, :invalid_origin}
    end
  end

  defp valid_dns_host?(host) do
    byte_size(host) <= @max_host_bytes and
      host
      |> String.split(".", trim: false)
      |> Enum.all?(&valid_label?/1)
  end

  defp valid_label?(label) do
    byte_size(label) <= @max_label_bytes and Regex.match?(@label, label)
  end

  defp port(%URI{port: port}, scheme) do
    default = Map.fetch!(@schemes, scheme)

    cond do
      not is_integer(port) -> {:ok, default}
      port < 0 or port > 65_535 -> {:error, :invalid_origin}
      true -> {:ok, port}
    end
  end

  defp render(%{scheme: scheme, host: host, port: port}) do
    port_suffix =
      if port == Map.fetch!(@schemes, scheme), do: "", else: ":" <> Integer.to_string(port)

    scheme <> "://" <> host <> port_suffix
  end

  defp wildcard_host?(host), do: String.starts_with?(host, @wildcard_prefix)

  defp add_canonical(raw_origin, acc) do
    case normalize(raw_origin) do
      {:ok, origin} ->
        if origin in acc, do: {:error, :duplicate_origin}, else: {:ok, [origin | acc]}

      {:error, :invalid_origin} ->
        {:error, :invalid_origin}
    end
  end

  defp wildcard_match?(origin, pattern) do
    suffix = String.replace_prefix(pattern.host, @wildcard_prefix, "")

    origin.scheme == pattern.scheme and origin.port == pattern.port and
      String.ends_with?(origin.host, "." <> suffix) and
      byte_size(origin.host) > byte_size(suffix) + 1
  end
end
