defmodule EbbServer.Storage.Fields do
  @moduledoc """
  Utilities for extracting field values from entity data structures.

  Handles:
  - Nested data with `data["fields"]` fallback
  - `{"value": ...}` wrapper unwrapping
  - Binary value passthrough
  """

  @doc """
  Extracts a field value from data.

  Options:
  - `:nested?` - When true, falls back to `data["fields"]` if key not found directly (default: true)

  ## Examples

      iex> Fields.get(%{"actor_id" => %{"value" => "user123"}}, "actor_id")
      "user123"

      iex> Fields.get(%{"fields" => %{"actor_id" => %{"value" => "user123"}}}, "actor_id")
      "user123"

      iex> Fields.get(%{"actor_id" => "user123"}, "actor_id")
      "user123"

      iex> Fields.get(nil, "actor_id")
      nil
  """
  @spec get(map() | nil, String.t(), keyword()) :: any() | nil
  def get(data, field, opts \\ [])

  def get(nil, _field, _opts), do: nil

  def get(data, field, opts) when is_map(data) do
    nested? = Keyword.get(opts, :nested?, true)

    cond do
      Map.has_key?(data, field) ->
        unwrap_value(data[field])

      nested? and Map.has_key?(data, "fields") and is_map(data["fields"]) ->
        get(data["fields"], field, nested?: false)

      true ->
        nil
    end
  end

  defp unwrap_value(%{"value" => value}), do: value
  defp unwrap_value(nil), do: nil
  defp unwrap_value(value), do: value
end
