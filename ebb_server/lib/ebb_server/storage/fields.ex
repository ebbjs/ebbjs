defmodule EbbServer.Storage.Fields do
  @moduledoc """
  Extracts field values from update data.

  Walks one level under `data.fields` and unwraps the `{"value": ...}`
  envelope so callers get the underlying field value as a string,
  number, list, etc.
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

  @doc """
  Reads one field from either shape a caller may hold.

  A raw component Update carries its field name and the component's value
  (`%{field: "source_id", data: <leaf>}`); a folded row mutation carries the
  row's field record (`%{data: %{"fields" => ...}}`). Helpers that were
  written against the row shape keep working on the wire shape through this
  one accessor, so a component whose field is not the one asked for reads as
  absent rather than as a value.

  ## Examples

      iex> Fields.component_value(%{field: "source_id", data: %{"value" => "e_1"}}, "source_id")
      "e_1"

      iex> Fields.component_value(%{field: "target_id", data: %{"value" => "e_1"}}, "source_id")
      nil

      iex> Fields.component_value(%{data: %{"fields" => %{"source_id" => %{"value" => "e_1"}}}}, "source_id")
      "e_1"
  """
  @spec component_value(map() | nil, String.t()) :: any() | nil
  def component_value(%{field: field, data: data}, wanted) when is_binary(field) do
    if field == wanted, do: unwrap_value(data), else: nil
  end

  def component_value(%{data: data}, wanted), do: get(data, wanted)
  def component_value(_update, _wanted), do: nil

  @doc """
  Reports whether update data carries a field at all.

  Distinct from `get/2`: a present field whose value is `nil` is still
  present. The planner uses this to tell a patch that omits a field from one
  that intends to write it.

  ## Examples

      iex> Fields.present?(%{"fields" => %{"apps" => %{"map" => %{}}}}, "apps")
      true

      iex> Fields.present?(%{"fields" => %{}}, "apps")
      false
  """
  @spec present?(map() | nil, String.t()) :: boolean()
  def present?(nil, _field), do: false

  def present?(data, field) when is_map(data) do
    case Map.get(data, "fields") do
      %{} = fields when is_map(fields) -> Map.has_key?(fields, field)
      _ -> false
    end
  end

  def present?(_data, _field), do: false

  defp unwrap_value(%{"value" => value}), do: value
  defp unwrap_value(nil), do: nil
  defp unwrap_value(value), do: value
end
