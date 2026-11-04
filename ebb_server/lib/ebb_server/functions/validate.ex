defmodule EbbServer.Functions.Validate do
  @moduledoc """
  Runs a bundle's RPC schemas against decoded JSON.

  Validation happens here, before any worker is checked out or spawned, so a
  request that cannot possibly run costs nothing and the runner never has to
  defend itself against ordinary bad input. It is not the only validation: the
  runner revalidates with the full Standard Schema, which carries the entity
  schema and refinements the JSON Schema form cannot express. This side is the
  cheap gate at the trust boundary; the client is not trusted to have checked
  first.

  The schemas are already resolved. `Bundle.new/2` resolves each one once while
  the bundle is built, and `BundleCache` caches that struct, so this module
  never pays for resolution on an invocation — and a schema that cannot be
  resolved fails load or activation instead of surfacing here.

  Failures are structured: `{"path" => "items[0].name", "message" => "..."}`.
  The path is the validator's JSON pointer rewritten to dotted form, and only
  the first ten issues are returned. `issues` is the only structured
  field on the error envelope; `details` stays a string for single-reason
  write-pipeline failures because `packages/write/src/rejection.ts` publishes
  it as `String | Null`.
  """

  @max_issues 10

  alias EbbServer.Functions.Bundle
  alias ExJsonSchema.Validator
  alias ExJsonSchema.Validator.Error

  @type issue :: %{required(String.t()) => String.t()}

  @doc """
  Validates a function's params against the bundle's params schema.

  A bundle without one accepts anything, which is the schema's absence being
  the contract rather than an implicit `true` schema.
  """
  @spec params(Bundle.t(), term()) :: :ok | {:error, [issue()]}
  def params(%Bundle{resolved_params_schema: nil}, _data), do: :ok
  def params(%Bundle{resolved_params_schema: root}, data), do: validate(root, data)

  @doc """
  Validates a function's result against the bundle's optional output schema.
  """
  @spec output(Bundle.t(), term()) :: :ok | {:error, [issue()]}
  def output(%Bundle{resolved_output_schema: nil}, _data), do: :ok
  def output(%Bundle{resolved_output_schema: root}, data), do: validate(root, data)

  defp validate(root, data) do
    case Validator.validate(root, data, error_formatter: false) do
      :ok ->
        :ok

      {:error, errors} when is_list(errors) ->
        {:error, errors |> Enum.take(@max_issues) |> Enum.map(&issue/1)}

      # A reference the validator cannot follow is a broken schema, which
      # should have failed load. Answer it as one issue rather than crashing
      # an invocation on data that is already suspect.
      {:error, reason} ->
        {:error, [%{"path" => "", "message" => message(reason)}]}
    end
  end

  defp issue(%Error{error: error, path: pointer}) do
    %{"path" => path(pointer), "message" => message(error)}
  end

  defp message(error) do
    to_string(error)
  rescue
    _error -> inspect(error)
  end

  defp path("#"), do: ""

  defp path("#/" <> pointer) do
    pointer
    |> String.split("/")
    |> Enum.map(&unescape/1)
    |> Enum.with_index()
    |> Enum.map_join(fn {token, index} -> segment(token, index) end)
  end

  defp path(pointer), do: pointer

  defp segment(token, index) do
    cond do
      String.match?(token, ~r/\A\d+\z/) -> "[#{token}]"
      index == 0 -> token
      true -> "." <> token
    end
  end

  # RFC 6901: `~1` is `/` and `~0` is `~`, and `~01` must stay `~1`, so the
  # slash is restored first.
  defp unescape(token), do: token |> String.replace("~1", "/") |> String.replace("~0", "~")
end
