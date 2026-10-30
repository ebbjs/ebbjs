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

  The code is derived from the status because `Functions.Invocation` reports
  only `{:error, status, details}`; the worker-facing error name does not
  survive the boundary. `code_for_status/1` is therefore the mapping, and a
  status outside it falls back to `internal_error` rather than inventing a
  vocabulary.

  Structured `issues: [{"path", "message"}]` is deliberately not built here.
  `#595` adds it, and only for `invalid_input`/`invalid_output`; offering a
  helper now would invite endpoints to attach issues to statuses whose client
  schema expects a plain `details` string.
  """

  @type headers :: [{String.t(), String.t()}]
  @type response :: {pos_integer(), map(), headers()}

  @retryable_statuses [408, 429, 503]

  @status_codes %{
    400 => "invalid_input",
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
    * `:details` — optional human-readable reason; omitted when nil or empty
  """
  @spec failure(pos_integer(), keyword()) :: response()
  def failure(status, opts) do
    body =
      %{
        "error" => code_for_status(status),
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

  defp put_details(body, details) when is_binary(details) and details != "" do
    Map.put(body, "details", details)
  end

  defp put_details(body, _details), do: body

  defp put_retryable(body, status) when status in @retryable_statuses do
    Map.put(body, "retryable", true)
  end

  defp put_retryable(body, _status), do: body
end
