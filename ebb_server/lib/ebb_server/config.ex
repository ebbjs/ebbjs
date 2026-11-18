defmodule EbbServer.Config do
  @moduledoc """
  The one home for environment-variable resolution.

  Five modules used to carry their own copy of "read the variable, fall back to
  the `:ebb_server` application key, treat blank as unset", which is how three
  incompatible boolean vocabularies and an inconsistently honoured
  `EBB_DATA_DIR` coexisted. Everything that reads an `EBB_*` variable now comes
  through here, so precedence, the blank-means-unset rule, and the accepted
  spellings are decided in one place.

  The environment winning over the compiled value is deliberate for the
  settings resolved here: a release cannot be edited, and an operator's runtime
  instruction must not be silently overridden by a value baked in at build
  time. `data_dir/0` is the exception and keeps the opposite order, because
  `MIX_ENV=test` declares its path in `config/test.exs` and must not leak test
  state into `./data`.
  """

  @truthy ~w(true 1 yes on)
  @falsy ~w(false 0 no off)
  @boolean_names Enum.join(@truthy ++ @falsy, ", ")

  @doc """
  The trimmed value of `name`, or `nil` when it is unset or blank.
  """
  @spec env(String.t()) :: String.t() | nil
  def env(name) do
    case System.get_env(name) do
      nil -> nil
      raw -> raw |> String.trim() |> blank_to_nil()
    end
  end

  @doc """
  `env_name` when it is set to something non-blank, otherwise
  `Application.get_env(:ebb_server, app_key)`.

  A value is returned exactly as written, without trimming: each boot-time
  setting validates its own format (an auth mode name, a boolean, a tag list)
  and the parser that follows is the one that normalizes it. Only the
  emptiness test trims.
  """
  @spec env_over_app(String.t(), atom()) :: term()
  def env_over_app(env_name, app_key) do
    case blank_to_nil(System.get_env(env_name)) do
      nil -> compiled(Application.get_env(:ebb_server, app_key))
      value -> value
    end
  end

  @doc """
  `raw` as a boolean, raising with `source` named when it is not one.

  Accepts the booleans themselves, as the application env may hold them, and
  every spelling an operator or an older copy of this code accepted:
  #{@boolean_names}. Matching is case-insensitive and surrounding whitespace is
  ignored, so `" TRUE "` and `"on"` mean the same thing.
  """
  @spec boolean!(term(), String.t()) :: boolean()
  def boolean!(raw, _source) when is_boolean(raw), do: raw

  def boolean!(raw, source) do
    case raw |> to_string() |> String.trim() |> String.downcase() do
      flag when flag in @truthy ->
        true

      flag when flag in @falsy ->
        false

      _other ->
        raise "#{source} must be one of #{@boolean_names} (case-insensitive); " <>
                "got #{inspect(raw)}"
    end
  end

  @doc """
  The data directory: the compiled value, then `EBB_DATA_DIR`, then `./data`.

  Every reader of the directory goes through this, so a node configured only
  through `EBB_DATA_DIR` keeps its storage, app registry, function state, and
  worker sockets on the same volume.
  """
  @spec data_dir() :: String.t()
  def data_dir do
    Application.get_env(:ebb_server, :data_dir) || env("EBB_DATA_DIR") || "./data"
  end

  @doc """
  `nil` for a blank string, the value otherwise.

  Strict about type: a non-string reads as unset, so a value put into the
  application env by hand cannot be mistaken for configured text.
  """
  @spec blank_to_nil(term()) :: String.t() | nil
  def blank_to_nil(value) when is_binary(value) do
    if String.trim(value) == "", do: nil, else: value
  end

  def blank_to_nil(_value), do: nil

  # Compiled settings may be atoms, lists, or numbers as well as strings; those
  # are not text and pass through unchanged.
  defp compiled(value) when is_binary(value), do: blank_to_nil(value)
  defp compiled(value), do: value
end
