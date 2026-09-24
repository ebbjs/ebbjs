defmodule EbbServer.Storage.Fields do
  @moduledoc """
  Utilities for extracting field values from entity data structures.

  Every entity's update `data` is now shaped as `{"fields": {name: FieldValue}}`
  (see ebbjs/ebbjs#140). This module walks one level under `fields` and
  unwraps the `{"value": ...}` envelope.
  """

  @doc """
  Extracts a field value from data.

  ## Examples

      iex> Fields.get(%{"fields" => %{"actor_id" => %{"value" => "user123"}}}, "actor_id")
      "user123"

      iex> Fields.get(%{"fields" => %{"count" => %{"value" => 3}}}, "count")
      3

      iex> Fields.get(nil, "actor_id")
      nil

      iex> Fields.get(%{"fields" => %{}}, "actor_id")
      nil
  """
  @spec get(map() | nil, String.t()) :: any() | nil
  def get(nil, _field), do: nil

  def get(data, field) when is_map(data) do
    case Map.get(data, "fields") do
      %{} = fields when is_map(fields) -> unwrap_value(Map.get(fields, field))
      _ -> nil
    end
  end

  defp unwrap_value(%{"value" => value}), do: value
  defp unwrap_value(nil), do: nil
  defp unwrap_value(value), do: value
end
