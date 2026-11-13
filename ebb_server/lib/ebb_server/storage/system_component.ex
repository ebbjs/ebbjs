defmodule EbbServer.Storage.SystemComponent do
  @moduledoc """
  The platform's four components, and the one way to read them.

  `ebb/` is the platform namespace. A row that carries only platform
  components is committed under the model `ebb`; the **component** is what
  names its kind, so every module asks `kind/1` about a component rather
  than a model, and reads `source_id` and friends through the component's
  value here.

  | kind          | component        | value                                 | scope owner | by-id cache           |
  | ------------- | ---------------- | ------------------------------------- | ----------- | --------------------- |
  | `:grant`      | `ebb/grant`      | `{actor_id, group_id, permissions}`   | `group_id`  | `:group_members_by_id` |
  | `:membership` | `ebb/membership` | `{entity_id, group_id}`               | `group_id`  | `:entity_groups_by_id` |
  | `:link`       | `ebb/link`       | `{source_id, target_id, type, field}` | `source_id` | `:relationships_by_id` |
  | `:group`      | `ebb/group`      | `{name, apps}`                        | `self`      | `:group_apps`          |

  The **scope owner** is how a row's write finds its group set, and
  `EbbServer.Storage.EntityIndex` reads it here rather than dispatching on
  a kind. There are three shapes: `:self` means the row's own id is its
  group set; `{:field, name, :group}` means the value at `name` is a group
  id and a group owns itself; `{:field, name, :entity}` means the value at
  `name` is an entity id and the scope is that entity's membership set.
  A component with no declaration is a user component, whose scope is its
  own membership set.

  The **by-id cache** is the `opts` key of the one cache that can answer
  "which row has this id?" for the kind. All four store `{id, row}` rows,
  so a reader needs one generic lookup rather than a per-kind module call.
  `:group_apps` stays optional: a caller that only resolves user entities
  need not pass it.

  Each value is **atomic**: one Update carries the whole object, so a torn
  edge, membership, or grant is unrepresentable and there is no "wire value
  wins, cache supplies the rest" merge to get wrong. The value is stored at
  the row field named after the kind (`fields.link`), which is why `value/2`
  reads one field rather than four.

  `:membership` and `:link` have an immutable key after create
  (`(entity_id, group_id)` and `source_id`); the authorizer refuses a
  re-point and says so. Which of the four a *stored* id carries cannot be
  read off an Update — a delete names no component — so that question is
  `EbbServer.Storage.EntityIndex.kind/2`, which scans the by-id caches in
  `kinds/0` order.
  """

  @model "ebb"

  # Declaration order is the by-id precedence of `EntityIndex.kind/2`.
  @declarations [
    grant: %{
      name: "ebb/grant",
      scope: {:field, "group_id", :group},
      by_id: :group_members_by_id
    },
    membership: %{
      name: "ebb/membership",
      scope: {:field, "group_id", :group},
      by_id: :entity_groups_by_id
    },
    link: %{
      name: "ebb/link",
      scope: {:field, "source_id", :entity},
      by_id: :relationships_by_id
    },
    group: %{
      name: "ebb/group",
      scope: :self,
      by_id: :group_apps
    }
  ]

  @kinds Keyword.keys(@declarations)
  @components Map.new(@declarations)
  @kinds_by_component Map.new(@declarations, fn {kind, declaration} ->
                        {declaration.name, kind}
                      end)

  @type kind :: :group | :grant | :membership | :link
  @type scope :: :self | {:field, String.t(), :group | :entity}

  @doc "The model every platform row is committed under."
  @spec model() :: String.t()
  def model, do: @model

  @doc """
  The four kinds in declaration order.

  That order is `EbbServer.Storage.EntityIndex.kind/2`'s by-id
  precedence: ids are not model-unique here, so a colliding id answers the
  same kind it always has.
  """
  @spec kinds() :: [kind()]
  def kinds, do: @kinds

  @doc "The component name for a kind."
  @spec component(kind()) :: String.t()
  def component(kind), do: Map.fetch!(@components, kind).name

  @doc """
  How a kind's write resolves its group set.

  `:self`, `{:field, name, :group}`, `{:field, name, :entity}`, or `nil`
  for something that is not a platform kind.
  """
  @spec scope(term()) :: scope() | nil
  def scope(kind) do
    case Map.fetch(@components, kind) do
      {:ok, %{scope: scope}} -> scope
      :error -> nil
    end
  end

  @doc """
  The `opts` key of the kind's by-id cache, or `nil` for a non-platform
  kind.
  """
  @spec by_id(term()) :: atom() | nil
  def by_id(kind) do
    case Map.fetch(@components, kind) do
      {:ok, %{by_id: cache}} -> cache
      :error -> nil
    end
  end

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
