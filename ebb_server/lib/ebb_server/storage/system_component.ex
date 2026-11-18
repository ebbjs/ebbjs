defmodule EbbServer.Storage.SystemComponent do
  @moduledoc """
  The platform's four components, and the one way to read them.

  `ebb/` is the platform namespace. A row that carries only platform
  components is committed under the model `ebb`; the **component** is what
  names its kind, so every module asks `kind/1` about a component rather
  than a model, and reads a value path through the component here.

  | kind          | component        | value                                       | scope owner |
  | ------------- | ---------------- | ------------------------------------------- | ----------- |
  | `:grant`      | `ebb/grant`      | `{actor_id, group_id, permissions}`         | `group_id`  |
  | `:membership` | `ebb/membership` | `{entity_id, group_id}`                     | `group_id`  |
  | `:link`       | `ebb/link`       | `{<field>: {<type>: {<target_id>: true}}}`  | none        |
  | `:group`      | `ebb/group`      | `{name, apps}`                              | `self`      |

  The **scope owner** is how a row's write finds its group set, and
  `EbbServer.Storage.EntityScope` reads it here rather than dispatching on
  a kind. There are two shapes: `:self` means the row's own id is its
  group set; `{:field, name, :group}` means the value at `name` is a group
  id and a group owns itself. A component with no declaration is a
  component whose scope is its own membership set — `ebb/link` is one:
  it is keyed on its source, so the row carrying it *is* the source and
  the default path is already the right scope.

  The **by-id cache** is the `opts` key of the one cache that can answer
  "which row has this id?" for the kind. Each of the three declares one,
  so a reader needs one generic lookup rather than a per-kind module call.
  `:group_apps` stays optional: a caller that only resolves user entities
  need not pass it. `ebb/link` declares none: it is a component of its
  source, so no row id resolves to a link and nothing can ask which row
  carries one.

  `:grant`, `:membership` and `:group` are **atomic**: one Update carries
  the whole object, so a torn membership or grant is unrepresentable and
  there is no "wire value wins, cache supplies the rest" merge to get
  wrong. `:link` is **keyed** instead: its value nests one presence per
  edge, and one Update writes one edge, so two edges of one source merge
  without clobbering each other.

  `:membership` has an immutable key after create (`(entity_id, group_id)`)
  and `:grant`'s `group_id` is immutable; the authorizer refuses a re-point
  and says so. `:link` left that list: an edge keyed on its source has no
  source field to re-point. Which kind a *stored* id carries cannot be read
  off an Update — a delete names no component — so that question is
  `EbbServer.Storage.EntityScope.kind/2`, which scans the by-id caches in
  `kinds/0` order.
  """

  @model "ebb"

  # Declaration order is the by-id precedence of `EntityScope.kind/2`.
  @declarations [
    grant: %{
      name: "ebb/grant",
      scope: {:field, :group_id, :group},
      by_id: :grants_by_id
    },
    membership: %{
      name: "ebb/membership",
      scope: {:field, :group_id, :group},
      by_id: :memberships_by_id
    },
    link: %{
      name: "ebb/link",
      overlay: true
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
  @type scope :: :self | {:field, atom(), :group}

  @spec model() :: String.t()
  def model, do: @model

  @spec kinds() :: [kind()]
  def kinds, do: @kinds

  @spec component(kind()) :: String.t()
  def component(kind), do: Map.fetch!(@components, kind).name

  @doc """
  Whether a kind is an **overlay**: a component the platform adds to a row it
  does not model.

  `ebb/link` is the one: it is keyed on its source, so the row carrying it
  *is* the source and keeps whatever model committed it. Every other platform
  component is a row of its own, committed under `ebb`. That distinction is
  what lets an overlay write skip the row's model without letting a
  platform-only row be committed under a user model.
  """
  @spec overlay?(term()) :: boolean()
  def overlay?(kind), do: declaration(kind, :overlay) == true

  @spec scope(term()) :: scope() | nil
  def scope(kind), do: declaration(kind, :scope)

  @spec by_id(term()) :: atom() | nil
  def by_id(kind), do: declaration(kind, :by_id)

  defp declaration(kind, key) do
    case Map.fetch(@components, kind) do
      {:ok, declaration} -> Map.get(declaration, key)
      :error -> nil
    end
  end

  @spec kind(term()) :: kind() | nil
  def kind(component) when is_binary(component), do: Map.get(@kinds_by_component, component)
  def kind(_component), do: nil

  @spec component?(term()) :: boolean()
  def component?(component), do: kind(component) != nil

  @doc """
  The row field a kind's value is stored at: the leaf after the `/`.

  A platform row carries one component, so this is also the field whose
  presence makes it a platform row. A user row may carry an `ebb/*` overlay
  at the same field, which is what keeps the value's key — not the row's
  model — the thing that names the component.
  """
  @spec field(kind()) :: String.t()
  def field(kind), do: Atom.to_string(kind)

  # The kind whose component occupies each **overlay** field name. Only an
  # overlay can share a user row's field; the other platform kinds are rows of
  # their own.
  @overlay_fields Map.new(
                    Enum.filter(@declarations, fn {_kind, declaration} ->
                      declaration[:overlay] == true
                    end),
                    fn {kind, _declaration} -> {Atom.to_string(kind), kind} end
                  )

  @doc """
  The component name a row field's value is stored under.

  An `ebb` row's field is `ebb/<field>`. The one overlay — `ebb/link` — may sit
  on a row of any model and never takes that row's model as its namespace
  (#820), so `link` is `ebb/link` wherever it lives. Every other field,
  including a user model's `group`/`grant`/`membership`, is a component of the
  row's own model: those platform kinds are rows of their own. The server keeps
  this rule here rather than reading a schema: the platform field names are
  static facts about the platform, not declarations. It mirrors `@ebbjs/core`'s
  `fieldComponent`, the same two-sided duplication the scope table carries.
  """
  @spec component_of_field(String.t(), String.t()) :: String.t()
  def component_of_field(model, field) do
    with true <- model != @model,
         {:ok, kind} <- Map.fetch(@overlay_fields, field) do
      component(kind)
    else
      _ -> model <> "/" <> field
    end
  end

  @spec value(map() | nil, kind()) :: map() | nil
  def value(data, kind) do
    case unwrap(component_data(data, kind)) do
      %{} = value -> value
      _ -> nil
    end
  end

  @spec path(map() | nil, kind(), String.t()) :: any() | nil
  def path(data, kind, name) do
    case value(data, kind) do
      nil -> nil
      value -> Map.get(value, name)
    end
  end

  @spec carries?(map() | nil, kind()) :: boolean()
  def carries?(data, kind), do: component_data(data, kind) != nil

  defp component_data(%{field: field, data: data}, kind) when is_binary(field) do
    if field == field(kind), do: data
  end

  defp component_data(%{"fields" => %{} = fields}, kind), do: Map.get(fields, field(kind))
  defp component_data(_data, _kind), do: nil

  defp unwrap(%{"value" => value}), do: value
  defp unwrap(value), do: value

  @spec group_apps(map() | nil) :: [String.t()] | nil
  def group_apps(data) do
    case path(data, :group, "apps") do
      nil -> nil
      apps when is_list(apps) -> apps
      _ -> nil
    end
  end
end
