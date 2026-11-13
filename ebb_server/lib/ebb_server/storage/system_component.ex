defmodule EbbServer.Storage.SystemComponent do
  @moduledoc """
  The platform's four components, and the one way to read them.

  `ebb/` is the platform namespace. A row that carries only platform
  components is committed under the model `ebb`; the **component** is what
  names its kind, so every module asks `kind/1` about a component rather than
  a model, and reads `source_id` and friends through the component's value
  here.

  | kind         | component        | value                                        |
  | ------------ | ---------------- | -------------------------------------------- |
  | `:group`     | `ebb/group`      | `{name, apps}`                               |
  | `:grant`     | `ebb/grant`      | `{actor_id, group_id, permissions}`          |
  | `:membership`| `ebb/membership` | `{entity_id, group_id}`                      |
  | `:link`      | `ebb/link`       | `{source_id, target_id, type, field}`        |

  Each value is **atomic**: one Update carries the whole object, so a torn
  edge, membership, or grant is unrepresentable and there is no "wire value
  wins, cache supplies the rest" merge to get wrong. The value is stored at
  the row field named after the kind (`fields.link`), which is why `value/2`
  reads one field rather than four.

  `:membership` and `:link` have an immutable key after create
  (`(entity_id, group_id)` and `source_id`); the authorizer refuses a
  re-point and says so. Which of the four a *stored* id carries cannot be
  read off an Update — a delete names no component — so that question is
  `EbbServer.Storage.EntityIndex.kind/2`, which reads the by-id caches.
  """

  @model "ebb"

  @kinds [:group, :grant, :membership, :link]

  @components %{
    group: "ebb/group",
    grant: "ebb/grant",
    membership: "ebb/membership",
    link: "ebb/link"
  }
  @kinds_by_component Map.new(@components, fn {kind, name} -> {name, kind} end)

  @type kind :: :group | :grant | :membership | :link

  @doc "The model every platform row is committed under."
  @spec model() :: String.t()
  def model, do: @model

  @doc "The four kinds, in declaration order."
  @spec kinds() :: [kind()]
  def kinds, do: @kinds

  @doc "The component name for a kind."
  @spec component(kind()) :: String.t()
  def component(kind), do: Map.fetch!(@components, kind)

  @doc "The kind a component name names, or `nil` for a non-platform component."
  @spec kind(term()) :: kind() | nil
  def kind(component) when is_binary(component), do: Map.get(@kinds_by_component, component)
  def kind(_component), do: nil

  @doc "Whether a component name belongs to the platform."
  @spec component?(term()) :: boolean()
  def component?(component), do: kind(component) != nil

  @doc """
  The row field a kind's value is stored at: the leaf after the `/`.

  A row carries at most one platform component, so this is also the field
  whose presence makes it a platform row.
  """
  @spec field(kind()) :: String.t()
  def field(kind), do: Atom.to_string(kind)

  @doc """
  The whole atomic value of `kind` on a row, or `nil` when the row does not
  carry it.

  Accepts the three shapes a caller may hold: a folded row mutation or a
  materialized row's data (`%{"fields" => %{...}}`), and a raw Update
  (`%{field: ..., data: %{"value" => ...}}`) whose field names this kind.
  """
  @spec value(map() | nil, kind()) :: map() | nil
  def value(data, kind) do
    case unwrap(component_data(data, kind)) do
      %{} = value -> value
      _ -> nil
    end
  end

  @doc """
  One field of `kind`'s value, or `nil` when the row does not carry the
  component or the value omits the field.
  """
  @spec path(map() | nil, kind(), String.t()) :: any() | nil
  def path(data, kind, name) do
    case value(data, kind) do
      nil -> nil
      value -> Map.get(value, name)
    end
  end

  @doc "Whether a row carries `kind` at all (a present component with any value)."
  @spec present?(map() | nil, kind()) :: boolean()
  def present?(data, kind), do: component_data(data, kind) != nil

  # A raw Update carries the component's value; a row record nests it.
  defp component_data(%{field: field, data: data}, kind) when is_binary(field) do
    if field == field(kind), do: data
  end

  defp component_data(%{"fields" => %{} = fields}, kind), do: Map.get(fields, field(kind))
  defp component_data(_data, _kind), do: nil

  defp unwrap(%{"value" => value}), do: value
  defp unwrap(value), do: value

  @doc "The `apps` list of a group value, or `nil` when it declares none."
  @spec group_apps(map() | nil) :: [String.t()] | nil
  def group_apps(data) do
    case path(data, :group, "apps") do
      nil -> nil
      apps when is_list(apps) -> apps
      _ -> nil
    end
  end
end
