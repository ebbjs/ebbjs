defmodule EbbServer.Functions.Response do
  @moduledoc """
  The single assembler for functions HTTP responses.

  Every functions endpoint builds its body and headers here, so the envelope
  has one definition rather than one per call site. Functions here are pure
  and Plug-free: each returns `{status, body, headers}` where `body` is a
  Jason-encodable map and `headers` is a list of `{name, value}` pairs ready
  for `Plug.Conn.put_resp_header/3`.

  Success is `{"ok": true, "result": ..., "invocation_id": ..., "version": ...}`.
  Failure is `{"error": "<code>", "invocation_id": ..., "version": ...}` plus
  `"details"` when the caller has text for it and `"retryable": true` on
  `408`/`429`/`503`. `error` is the code, as on every other endpoint: there is
  no `message` field and no second vocabulary.

  `invocation_id` and the function `version` also travel as response headers,
  `x-ebb-invocation-id` and `x-ebb-function-version`. A header is omitted when
  its value is absent, which is why an unknown function (`404`) carries no
  version header: there is no active version to name.

  A failure whose cause already produced a code — anything `Invocation`
  reports, such as `handler_error`, `rejected`, or `protocol_error` — passes it
  as `:code`. Without one, `code_for_status/1` supplies the code for the
  statuses this endpoint produces itself (a malformed body, an absent route, a
  bundle that failed verification). The map is the fallback, not a second
  vocabulary: both paths end in the same `"error"` field.

  ## No stacks

  `details` is text for a person, never a stack. A runner that reports a
  handler failure from its runtime can carry `error.stack`; the envelope drops
  lines shaped like stack frames and caps the rest, so an implementation detail
  of the worker cannot leak through the API. `#595` adds structured `issues`
  for validation, which is a different field.

  Structured `issues: [{"path", "message"}]` is deliberately not built here.
  `#595` adds it, and only for `invalid_input`/`invalid_output`; offering a
  helper now would invite endpoints to attach issues to statuses whose client
  schema expects a plain `details` string.
  """

  @type headers :: [{String.t(), String.t()}]
  @type response :: {pos_integer(), map(), headers()}

  @retryable_statuses [408, 429, 503]
  @max_details_bytes 1024
  @stack_frame ~r/^\s+at\s/

  @status_codes %{
    400 => "invalid_json",
    401 => "unauthorized",
    403 => "denied",
    404 => "not_found",
    408 => "timeout",
    413 => "payload_too_large",
    422 => "rejected",
    429 => "overloaded",
    500 => "internal_error",
    503 => "unavailable"
  }

  @doc """
  Builds a successful invocation response.

  Options:

    * `:invocation_id` — required id of this invocation
    * `:version` — the invoked function's active version; `nil` when unknown
  """
  @spec success(term(), keyword()) :: response()
  def success(result, opts) do
    body = %{
      "ok" => true,
      "result" => result,
      "invocation_id" => invocation_id(opts),
      "version" => version(opts)
    }

    {200, body, headers(opts)}
  end

  @doc """
  Builds a failed invocation response.

  Options:

    * `:invocation_id` — required id of this invocation
    * `:version` — the invoked function's active version; `nil` when unknown
    * `:code` — the error code, when the cause already named one
    * `:details` — optional human-readable reason; omitted when nil or empty
  """
  @spec failure(pos_integer(), keyword()) :: response()
  def failure(status, opts) do
    body =
      %{
        "error" => Keyword.get(opts, :code, code_for_status(status)),
        "invocation_id" => invocation_id(opts),
        "version" => version(opts)
      }
      |> put_details(Keyword.get(opts, :details))
      |> put_retryable(status)

    {status, body, headers(opts)}
  end

  @doc """
  Maps an HTTP status to the envelope's error code.
  """
  @spec code_for_status(term()) :: String.t()
  def code_for_status(status), do: Map.get(@status_codes, status, "internal_error")

  defp invocation_id(opts), do: Keyword.fetch!(opts, :invocation_id)

  defp version(opts), do: Keyword.get(opts, :version)

  defp headers(opts) do
    [
      header("x-ebb-invocation-id", invocation_id(opts)),
      header("x-ebb-function-version", version(opts))
    ]
    |> Enum.reject(&is_nil/1)
  end

  defp header(name, value) when is_binary(value) and value != "", do: {name, value}
  defp header(_name, _value), do: nil

  defp put_details(body, details) when is_binary(details) do
    case scrub(details) do
      "" -> body
      text -> Map.put(body, "details", String.slice(text, 0, @max_details_bytes))
    end
  end

  defp put_details(body, _details), do: body

  defp scrub(details) do
    details
    |> String.split("\n")
    |> Enum.reject(&Regex.match?(@stack_frame, &1))
    |> Enum.join("\n")
    |> String.trim()
  end

  defp put_retryable(body, status) when status in @retryable_statuses do
    Map.put(body, "retryable", true)
  end

  defp put_retryable(body, _status), do: body
end
