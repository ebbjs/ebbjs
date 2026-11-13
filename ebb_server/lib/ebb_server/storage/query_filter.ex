defmodule EbbServer.Storage.QueryFilter do
  @moduledoc """
  Validates the field-value filter a query carries before it reaches SQL.

  A filter is a disjunction of groups: each group maps top-level field names
  to the scalar value they must equal, keys within a group are ANDed, and
  groups are ORed. `EbbServer.Storage.EntityStore` applies this at the request
  boundary and `EbbServer.Storage.SQLite` applies it again inside the shared
  process, so a caller cannot hand the database a shape it is unable to build
  a statement from.

  Values are limited to JSON scalars: an array or object has no meaning on the
  right-hand side of the generated `json_extract(...)` comparison. Numbers
  must be values SQLite can bind: integers fit in a signed 64-bit word.

  A `nil` value is the predicate "no live value" — the leaf is absent or
  tombstoned. A `nil` entry where a group is expected is malformed: an empty
  conjunction is TRUE, so an empty group would silently drop the filter, and
  the two have to stay distinguishable. An empty group (or an empty list) is
  unfiltered, matching `nil`.

  A filter addresses a **user** component's value, one level below
  `data.fields.<field>`. A platform component's value is one atomic object at
  `data.fields.<kind>.value`, so no scalar equals it and a filter on one
  simply matches nothing; platform rows are selected by their component name
  instead (`EbbServer.Storage.EntityStore.query/4`).
  """

  # Every key adds one clause and one bind parameter. 64 keeps the parameter
  # count well inside SQLite's limit while leaving room for any realistic
  # multi-field query. It applies per group.
  @max_keys 64

  # SQLite stores integers as signed 64-bit. exqlite raises from its NIF when a
  # larger integer is bound, rather than returning an error a caller can handle.
  @min_integer -0x8000000000000000
  @max_integer 0x7FFFFFFFFFFFFFFF

  @type group :: %{optional(String.t()) => nil | boolean() | number() | String.t()}
  @type filter :: [group()]

  @doc """
  Returns the filter when it is a valid disjunction of field-value groups.

  `nil`, `[]`, and any list holding an empty group are unfiltered and return
  `nil`. Anything that is not a list of maps, holds a `nil` entry, carries a
  key that is not an identifier-shaped string, carries a value that is not a
  JSON scalar, or has more than #{@max_keys} keys in a group is rejected.
  """
  @spec normalize(term()) :: {:ok, filter() | nil} | {:error, :invalid_filter}
  def normalize(nil), do: {:ok, nil}
  def normalize([]), do: {:ok, nil}

  def normalize(groups) when is_list(groups) do
    cond do
      not Enum.all?(groups, &valid_group?/1) -> {:error, :invalid_filter}
      Enum.any?(groups, &(map_size(&1) == 0)) -> {:ok, nil}
      true -> {:ok, groups}
    end
  end

  def normalize(_filter), do: {:error, :invalid_filter}

  @doc "The largest number of field filters one group may carry."
  @spec max_keys() :: pos_integer()
  def max_keys, do: @max_keys

  defp valid_group?(group) when is_map(group) do
    map_size(group) <= @max_keys and Enum.all?(group, &valid_entry?/1)
  end

  defp valid_group?(_group), do: false

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
