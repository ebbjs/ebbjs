defmodule EbbServer.Storage.QueryFilter do
  @moduledoc """
  Validates the field-value filter a query carries before it reaches SQL.

  A filter maps top-level field names to the scalar value they must equal.
  `EbbServer.Storage.EntityStore` applies this at the request boundary and
  `EbbServer.Storage.SQLite` applies it again inside the shared process, so a
  caller cannot hand the database a shape it is unable to build a statement
  from.

  Values are limited to JSON scalars: an array or object has no meaning on the
  right-hand side of the generated `json_extract(...) = ?` comparison. Numbers
  must be values SQLite can bind: integers fit in a signed 64-bit word.
  """

  # Every key adds one clause and one bind parameter. 64 keeps the parameter
  # count well inside SQLite's limit while leaving room for any realistic
  # multi-field query.
  @max_keys 64

  # SQLite stores integers as signed 64-bit. exqlite raises from its NIF when a
  # larger integer is bound, rather than returning an error a caller can handle.
  @min_integer -0x8000000000000000
  @max_integer 0x7FFFFFFFFFFFFFFF

  @type filter :: %{optional(String.t()) => nil | boolean() | number() | String.t()}

  @doc """
  Returns the filter unchanged when it is a valid field-value filter.

  `nil` means "no filter". Anything that is not a map, carries a key that is
  not an identifier-shaped string, carries a value that is not a JSON scalar,
  or has more than #{@max_keys} keys is rejected.
  """
  @spec normalize(term()) :: {:ok, filter() | nil} | {:error, :invalid_filter}
  def normalize(nil), do: {:ok, nil}

  def normalize(filter) when is_map(filter) do
    if map_size(filter) <= @max_keys and Enum.all?(filter, &valid_entry?/1) do
      {:ok, filter}
    else
      {:error, :invalid_filter}
    end
  end

  def normalize(_filter), do: {:error, :invalid_filter}

  @doc "The largest number of field filters one query may carry."
  @spec max_keys() :: pos_integer()
  def max_keys, do: @max_keys

  defp valid_entry?({field, value}) do
    is_binary(field) and Regex.match?(~r/^[A-Za-z_][A-Za-z0-9_]*$/, field) and scalar?(value)
  end

  defp scalar?(nil), do: true
  defp scalar?(value) when is_boolean(value) or is_float(value) or is_binary(value), do: true

  defp scalar?(value) when is_integer(value) do
    value >= @min_integer and value <= @max_integer
  end

  defp scalar?(_value), do: false
end
