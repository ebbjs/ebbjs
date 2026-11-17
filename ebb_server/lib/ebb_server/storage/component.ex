defmodule EbbServer.Storage.Component do
  @moduledoc """
  The one owner of the component envelope's vocabulary.

  A component Update names one `(entity, component)`. A `ComponentName` is
  `<model>/<field>`:

    - the segment before the first `/` is the **model** the row is committed
      under — the permission subject, the query source, and the committed-model
      key;
    - the segment after it is the row **field** the component's value is
      stored at.

  A row-scoped `create` names no component: it carries the row's `model` and
  the create's `hlc` instead. A `delete` names no component either.

  Exactly one `/`, both segments non-empty. The server has no schema, so this
  shape is the whole of what the wire promises, and every module that has to
  read either half goes through here: one definition rather than five that
  can disagree about what a component is.

  Refusing a malformed name is `EbbServer.Storage.ActionValidator`'s job, and
  the only place it happens: it is the only writer-facing boundary. Everything
  else reads a component that validation already accepted, or a stored frame
  that validates on decode, so `split/1` and friends raise rather than return
  an error tuple — a malformed name there is a bug, not a rejection.

  The envelope's key sets and method set live here too, for the same reason:
  the validator and the stored-frame reader must accept exactly the same
  shape, and the old wire's `put`/`patch` must be unreadable in both.
  """

  @update_keys ["id", "subject_id", "component", "model", "method", "hlc", "data"]
  @component_keys ["id", "subject_id", "component", "method", "data"]
  @row_method_keys ["id", "subject_id", "method", "data"]
  @create_keys ["id", "subject_id", "model", "method", "hlc", "data"]
  @method_pairs [
    {"create", :create},
    {"merge", :merge},
    {"replace", :replace},
    {"drop", :drop},
    {"delete", :delete}
  ]
  @methods Map.new(@method_pairs)

  @value_methods ["merge", "replace"]

  @type name :: String.t()
  @type method :: :create | :merge | :replace | :drop | :delete

  @doc """
  Every key a stored or received Update may carry.

  The per-method key sets below are the exact ones; this union is the
  first-pass filter for a key no Update of any method may name.
  """
  @spec update_keys() :: [String.t()]
  def update_keys, do: @update_keys

  @doc "The exact key set of a `create` Update."
  @spec create_keys() :: [String.t()]
  def create_keys, do: @create_keys

  @doc "The exact key set of a component Update (`merge`, `replace`, `drop`)."
  @spec component_keys() :: [String.t()]
  def component_keys, do: @component_keys

  @doc "The exact key set of a `delete` Update, which names the row."
  @spec row_method_keys() :: [String.t()]
  def row_method_keys, do: @row_method_keys

  @doc "The exact key set of any Update with `method`."
  @spec update_keys_for(term()) :: [String.t()]
  def update_keys_for("create"), do: @create_keys
  def update_keys_for("delete"), do: @row_method_keys
  def update_keys_for(method) when method in ["merge", "replace", "drop"], do: @component_keys
  def update_keys_for(_method), do: @update_keys

  @doc "The wire method strings, in the order an error message names them."
  @spec method_names() :: [String.t()]
  def method_names, do: Enum.map(@method_pairs, &elem(&1, 0))

  @doc "Whether `method` is one of the envelope's wire methods."
  @spec method?(term()) :: boolean()
  def method?(method), do: is_binary(method) and Map.has_key?(@methods, method)

  @doc """
  Whether the method carries a component value.

  Only `merge` and `replace` write a field and so carry a value. `create`,
  `drop` and `delete` carry none: `create` states the row, `drop` detaches
  one component, `delete` tombstones the row.
  """
  @spec value_method?(term()) :: boolean()
  def value_method?(method), do: method in @value_methods

  @doc "The wire string for a method, given as its atom or already as a string."
  @spec method_string(method() | String.t()) :: String.t()
  def method_string(method) when is_atom(method), do: Atom.to_string(method)
  def method_string(method) when is_binary(method), do: method

  @doc "The internal method for a wire method string."
  @spec to_method(String.t()) :: method()
  def to_method(method) do
    case Map.fetch(@methods, method) do
      {:ok, atom} ->
        atom

      :error ->
        raise ArgumentError,
              "an Update method is one of #{Enum.join(method_names(), ", ")}, " <>
                "got: #{inspect(method, limit: 4)}"
    end
  end

  @doc """
  Whether `component` is a well-formed `<model>/<field>` name.

  The validator's error path needs a question rather than a raise, because a
  malformed name there is a rejection that names what arrived.
  """
  @spec valid?(term()) :: boolean()
  def valid?(component) when is_binary(component) do
    case :binary.split(component, "/") do
      [model, field] -> model != "" and field != "" and :binary.match(field, "/") == :nomatch
      _ -> false
    end
  end

  def valid?(_component), do: false

  @doc "The component's `{model, field}`."
  @spec split(name()) :: {String.t(), String.t()}
  def split(component) when is_binary(component) do
    if valid?(component) do
      [model, field] = :binary.split(component, "/")
      {model, field}
    else
      malformed!(component)
    end
  end

  def split(component), do: malformed!(component)

  @doc "The model a component's value is committed under."
  @spec model(name()) :: String.t()
  def model(component), do: component |> split() |> elem(0)

  @doc "The row field a component's value is stored at."
  @spec field(name()) :: String.t()
  def field(component), do: component |> split() |> elem(1)

  defp malformed!(component) do
    raise ArgumentError,
          "a component is <model>/<field>, got: #{inspect(component, limit: 4)}"
  end
end
