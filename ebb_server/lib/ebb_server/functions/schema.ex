defmodule EbbServer.Functions.Schema do
  @moduledoc """
  Draft-7 JSON Schema resolution, with one error shape.

  The bundle constructor and the store ask the same question — can this
  document be resolved as a draft-7 schema? — and both must answer with the
  same `{:invalid_schema, field, reason}`, so a corrupt schema is refused at
  upload and again at activation rather than surfacing on the first call. This
  module is that one answer.

  `resolve/2` returns the raw document beside its resolved
  `ExJsonSchema.Schema.Root`; a caller that will validate data keeps the root,
  while the store only needs the yes/no and uses `validate/2`. Draft-7 allows a
  schema to be a boolean (`true` accepts everything, `false` accepts nothing),
  and the validator resolves both, so this module does not narrow the language
  a bundle may speak.

  `validate_text/2` is for a schema read back from storage: a row corrupted
  after upload must be refused, not read as "no schema".
  """

  alias ExJsonSchema.Schema, as: JsonSchema

  @type error :: {:invalid_schema, String.t(), String.t()}

  @doc """
  Resolves `schema`, returning the raw document and its resolved root.
  """
  @spec resolve(term(), String.t()) :: {:ok, term(), term()} | {:error, error()}
  def resolve(nil, _field), do: {:ok, nil, nil}

  def resolve(schema, _field) when is_boolean(schema) do
    {:ok, schema, JsonSchema.resolve(schema)}
  end

  def resolve(schema, field) when is_map(schema) do
    {:ok, schema, JsonSchema.resolve(schema)}
  rescue
    error -> {:error, {:invalid_schema, field, Exception.message(error)}}
  catch
    kind, reason -> {:error, {:invalid_schema, field, inspect({kind, reason})}}
  end

  def resolve(_schema, field) do
    {:error, {:invalid_schema, field, "schema must be a JSON object or boolean"}}
  end

  @doc """
  Whether `schema` can be resolved, with no root to keep.
  """
  @spec validate(term(), String.t()) :: :ok | {:error, error()}
  def validate(schema, field) do
    case resolve(schema, field) do
      {:ok, _raw, _root} -> :ok
      {:error, _reason} = error -> error
    end
  end

  @doc """
  Validates schema text as read back from storage.
  """
  @spec validate_text(term(), String.t()) :: :ok | {:error, error()}
  def validate_text(nil, _field), do: :ok

  def validate_text(text, field) when is_binary(text) do
    case Jason.decode(text) do
      {:ok, schema} ->
        validate(schema, field)

      {:error, reason} ->
        {:error, {:invalid_schema, field, "invalid JSON: #{Exception.message(reason)}"}}
    end
  end

  def validate_text(_text, field) do
    {:error, {:invalid_schema, field, "schema must be JSON text"}}
  end
end
