defmodule EbbServer.Storage.FieldMerge do
  @moduledoc """
  The wire's last-writer-wins field merge rule, as pure functions.

  `merge/2` hand-mirrors `packages/core/src/types/action.ts`'s
  `mergeFieldValue`. It is the protocol's definition of the rule, mirrored
  by the server and every client materializer so concurrent writes converge
  identically everywhere; the two copies must change together. `stamp/2` is
  the server's own step with no client counterpart: it makes the historical
  top-level wire shape self-describing before the merge.

  ## Wire shape

  A field value is either a **leaf** (`%{"value" => v, "update_id" =>
  id, "hlc" => hlc}`) or a **map** (`%{"map" => %{key => value}}`). The
  `map` key is the discriminant, so a map value is self-describing and the
  merge needs no schema.

  ## Merge rule

  - **Leaf over leaf**: the higher HLC wins; equal HLC breaks toward the
    lexicographically greater `update_id`. HLCs are compared numerically,
    so an integer and the decimal string that names it (`10` and `"10"`)
    order identically. IDs compare as plain strings, so `"id-10"` sorts
    before `"id-9"`; the order is deterministic, not semantically numeric.
  - **Map over map**: the key sets are unioned and every key present on
    both sides merges by this same rule, so a write to one key leaves its
    siblings untouched.
  - **Kind mismatch** (a leaf replacing a map or vice versa): the incoming
    value replaces the whole value. A field's kind is fixed by its schema,
    so this only happens for a schema violation and the incoming patch is
    the newer intent.
  - **Tombstone**: a leaf `value: null` participates in the merge like any
    other leaf, so a late-arriving write can still beat it. Storage retains
    it; projection is what hides a tombstoned map key.

  This deliberately keeps the materialization logic simple — there is no
  per-type dispatch table. CRDT-style merging (e.g. G-Counter, causal-tree
  text) is **not** a server-side concern: the per-leaf LWW rule is enough
  for the server's job (decide which blob wins), and the typed reducer on
  the client interprets a `causal-tree` blob correctly. See Epic #110 for
  how `e.collaborativeText()` is defined and Epic #111 for the
  storage-architecture rationale.
  """

  @typedoc """
  A leaf field value: `%{"value" => term, "hlc" => hlc, "update_id" => id}`.
  """
  @type leaf :: %{String.t() => term()}

  @typedoc """
  A map field value: `%{"map" => %{key => field_value}}`. The `map` key is
  the discriminant.
  """
  @type field_map :: %{String.t() => field_value()}

  @typedoc "Any field value on the wire."
  @type field_value :: leaf() | field_map()

  @doc """
  Merges `incoming` over `existing` under the wire's LWW rule.

  A `nil` `existing` returns `incoming` unchanged.
  """
  @spec merge(field_value() | nil, field_value()) :: field_value()
  def merge(nil, incoming), do: incoming

  def merge(existing, incoming) do
    cond do
      map_field?(existing) and map_field?(incoming) ->
        merged =
          Map.merge(existing["map"], incoming["map"], fn _key, existing_value, incoming_value ->
            merge(existing_value, incoming_value)
          end)

        %{"map" => merged}

      map_field?(existing) or map_field?(incoming) ->
        incoming

      true ->
        case compare_hlc(incoming["hlc"], existing["hlc"]) do
          :gt -> incoming
          :lt -> existing
          :eq -> tiebreak_winner(incoming, existing, incoming["update_id"], existing["update_id"])
        end
    end
  end

  @doc """
  Stamps every leaf in `field` with `update_id`, recursing into maps.

  A field's leaves are stamped with the update's id so the stored value is
  self-describing. A leaf that already carries a non-empty wire
  `update_id` keeps it: the client's fold trusts that value, so the server
  must use it too for an equal-HLC tiebreak to resolve identically on both
  sides. Only a leaf with no usable id — the historical top-level shape —
  falls back to the update's id.
  """
  @spec stamp(field_value(), String.t()) :: field_value()
  def stamp(%{"map" => entries}, update_id) when is_map(entries) do
    stamped =
      Enum.into(entries, %{}, fn {key, value} -> {key, stamp(value, update_id)} end)

    %{"map" => stamped}
  end

  def stamp(%{"update_id" => id} = leaf, _update_id) when is_binary(id) and id != "", do: leaf

  def stamp(leaf, update_id) when is_map(leaf), do: Map.put(leaf, "update_id", update_id)

  @doc """
  Compares two HLC values numerically.

  HLCs cross the wire either as integers or as decimal strings (the msgpack
  codec keeps values above the JS safe-integer range as strings). `nil` and
  unparseable values are treated as `0`.
  """
  @spec compare_hlc(integer() | String.t() | nil, integer() | String.t() | nil) :: :gt | :lt | :eq
  def compare_hlc(left, right) do
    left = hlc_value(left)
    right = hlc_value(right)

    cond do
      left > right -> :gt
      left < right -> :lt
      true -> :eq
    end
  end

  defp map_field?(field), do: is_map(field) and is_map(Map.get(field, "map"))

  defp hlc_value(nil), do: 0
  defp hlc_value(hlc) when is_integer(hlc), do: hlc

  defp hlc_value(hlc) when is_binary(hlc) do
    case Integer.parse(hlc) do
      {int, ""} -> int
      _ -> 0
    end
  end

  defp hlc_value(_), do: 0

  defp tiebreak_winner(new_field, existing, new_id, existing_id) do
    if new_id >= existing_id do
      Map.put(new_field, "update_id", new_id)
    else
      existing
    end
  end
end
