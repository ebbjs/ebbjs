defmodule EbbServer.Apps.Store do
  @moduledoc """
  Owns `<data_dir>/apps.json`, the durable form of the app registry.

  The document is versioned and deliberately small:

      {"version": 1,
       "apps": [{"id": "app_…", "name": "notes",
                 "origins": ["https://app.example.com"],
                 "created_at": "2026-01-01T00:00:00Z"}]}

  Writes go to a uniquely named temp file in the same directory and are moved
  into place with `File.rename/2`, so a reader (or a crash) never observes a
  half-written document. A failed rename removes the temp file.

  `load/1` validates the whole document — version, shape, name and origin
  rules, and the registry's uniqueness invariants — because this file is
  operator-editable and a partially trusted one is worse than none. Callers
  treat every validation failure the same way: start empty and leave the file
  alone so its owner can inspect it.
  """

  alias EbbServer.Apps.Origin

  @file_name "apps.json"
  @version 1
  @max_name_length 100

  @type app :: %{
          id: String.t(),
          name: String.t(),
          origins: [String.t()],
          created_at: String.t()
        }

  @doc """
  The registry document inside `data_dir`.

  ## Examples

      iex> Store.path("/var/lib/ebb")
      "/var/lib/ebb/apps.json"
  """
  @spec path(Path.t()) :: Path.t()
  def path(data_dir), do: Path.join(data_dir, @file_name)

  @doc """
  Reads and validates the registry document.

  An absent file is `{:error, :enoent}` and is not an error condition: a fresh
  install has no apps. Anything readable but not a valid document is
  `{:error, :corrupt}`.
  """
  @spec load(Path.t()) ::
          {:ok, [app()]} | {:error, :enoent} | {:error, :corrupt} | {:error, term()}
  def load(data_dir) do
    case File.read(path(data_dir)) do
      {:ok, content} -> decode(content)
      {:error, reason} -> {:error, reason}
    end
  end

  @doc """
  Replaces the registry document atomically.
  """
  @spec write(Path.t(), [app()]) :: :ok | {:error, term()}
  def write(data_dir, apps) do
    path = path(data_dir)

    with :ok <- File.mkdir_p(Path.dirname(path)),
         {:ok, content} <- encode(apps) do
      write_atomic(path, content)
    end
  end

  @doc """
  Trims and validates a display name.

  Names are for humans, so the comparison the registry enforces is
  case-insensitive over the trimmed form.
  """
  @spec normalize_name(term()) :: {:ok, String.t()} | {:error, :invalid_name}
  def normalize_name(name) when is_binary(name) do
    trimmed = String.trim(name)

    cond do
      trimmed == "" -> {:error, :invalid_name}
      not String.valid?(trimmed) -> {:error, :invalid_name}
      String.length(trimmed) > @max_name_length -> {:error, :invalid_name}
      true -> {:ok, trimmed}
    end
  end

  def normalize_name(_name), do: {:error, :invalid_name}

  defp encode(apps) do
    document = %{
      "version" => @version,
      "apps" => Enum.map(apps, &encode_app/1)
    }

    Jason.encode(document)
  end

  defp encode_app(app) do
    %{
      "id" => app.id,
      "name" => app.name,
      "origins" => app.origins,
      "created_at" => app.created_at
    }
  end

  defp write_atomic(path, content) do
    temp_path = temp_path(path)

    with :ok <- File.write(temp_path, content, [:binary]),
         :ok <- File.rename(temp_path, path) do
      :ok
    else
      {:error, reason} ->
        _ = File.rm(temp_path)
        {:error, reason}
    end
  end

  # A visible `*.tmp` name so a stray file is obvious in a directory listing
  # and a test can assert the write cleaned up after itself.
  defp temp_path(path) do
    unique = System.unique_integer([:positive, :monotonic])
    Path.join(Path.dirname(path), "#{Path.basename(path)}.#{unique}.tmp")
  end

  defp decode(content) do
    with {:ok, document} <- Jason.decode(content),
         {:ok, apps} <- validate_document(document) do
      {:ok, apps}
    else
      _ -> {:error, :corrupt}
    end
  end

  defp validate_document(%{"version" => @version, "apps" => raw_apps}) when is_list(raw_apps) do
    raw_apps
    |> Enum.reduce_while(initial_validation(), fn raw_app, acc ->
      with {:ok, app} <- validate_app(raw_app),
           {:ok, acc} <- admit(app, acc) do
        {:cont, acc}
      else
        _ -> {:halt, :error}
      end
    end)
    |> case do
      :error -> {:error, :corrupt}
      %{apps: apps} -> {:ok, Enum.reverse(apps)}
    end
  end

  defp validate_document(_document), do: {:error, :corrupt}

  defp initial_validation do
    %{apps: [], ids: MapSet.new(), names: MapSet.new(), origins: MapSet.new()}
  end

  defp validate_app(%{
         "id" => id,
         "name" => name,
         "origins" => origins,
         "created_at" => created_at
       }) do
    with true <- present_string?(id),
         {:ok, name} <- normalize_name(name),
         true <- is_list(origins) and origins != [],
         {:ok, origins} <- normalize_origins(origins),
         true <- present_string?(created_at) do
      {:ok, %{id: id, name: name, origins: origins, created_at: created_at}}
    else
      _ -> :error
    end
  end

  defp validate_app(_raw_app), do: :error

  defp present_string?(value), do: is_binary(value) and value != ""

  defp normalize_origins(raw_origins) do
    case Origin.normalize_all(raw_origins) do
      {:ok, origins} -> {:ok, origins}
      {:error, _reason} -> :error
    end
  end

  defp admit(app, acc) do
    name_key = String.downcase(app.name)

    if MapSet.member?(acc.ids, app.id) or
         MapSet.member?(acc.names, name_key) or
         Enum.any?(app.origins, &MapSet.member?(acc.origins, &1)) do
      :error
    else
      {:ok,
       %{
         apps: [app | acc.apps],
         ids: MapSet.put(acc.ids, app.id),
         names: MapSet.put(acc.names, name_key),
         origins: Enum.into(app.origins, acc.origins)
       }}
    end
  end
end
