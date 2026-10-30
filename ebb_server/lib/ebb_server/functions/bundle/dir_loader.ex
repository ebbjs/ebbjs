defmodule EbbServer.Functions.Bundle.DirLoader do
  @moduledoc """
  A bundle directory: `<bundle_dir>/<name>@<version>.envelope.json` beside
  `<bundle_dir>/<name>@<version>.js`.

  Every call lists, stats, and re-reads the directory, so replacing a bundle on
  disk needs no server restart and a digest is never trusted from an earlier
  read.

  The newest envelope mtime for a name is the active version. A tie would leave
  the answer to filesystem order, so it is broken by the greater version
  string, and two envelopes carrying the same version are refused outright as
  a duplicate active version — there is no way to tell which of them a deploy
  meant.

  An envelope's `name` and `version` must agree with the filename carrying it.
  The filename is how a deploy addresses a bundle, so a disagreement means the
  directory is not in the state the deploy intended, and the bundle is refused
  rather than served under a name its contents disown.

  Files that are neither an envelope nor a `.js` code file — a source map, an
  editor scratch file — are ignored, so they cannot disable a function. A
  bundle that is present but unreadable or malformed is an error, never a miss:
  a corrupted deployment must not read as an undeployed one.
  """

  @behaviour EbbServer.Functions.Bundle.Loader

  @envelope_suffix ".envelope.json"
  @code_suffix ".js"

  @type code :: binary()
  @type error ::
          {:unreadable_dir, String.t(), File.posix()}
          | {:unreadable, String.t(), term()}
          | {:malformed_filename, String.t()}
          | {:malformed_envelope, String.t(), term()}
          | {:name_mismatch, String.t(), term()}
          | {:version_mismatch, String.t(), term()}
          | {:duplicate_active_version, term()}
          | {:missing_envelope, String.t()}
          | {:missing_code, String.t(), String.t()}

  @type result ::
          {:ok, EbbServer.Functions.Bundle.Loader.envelope(), code()}
          | :not_found
          | {:error, error()}

  @impl true
  @spec load(String.t(), keyword()) :: result()
  def load(name, opts) do
    dir = Keyword.fetch!(opts, :dir)

    with {:ok, entries} <- entries(dir, name),
         {:ok, envelopes} <- read_envelopes(dir, entries.envelopes),
         :ok <- unique_versions(envelopes),
         :ok <- agree_with_filenames(envelopes, name),
         active = active_version(envelopes),
         {:ok, code} <- read_code(dir, name, active) do
      {:ok, active.envelope, code}
    end
  end

  defp entries(dir, name) do
    case File.ls(dir) do
      {:ok, basenames} -> classify(name, basenames)
      {:error, reason} -> {:error, {:unreadable_dir, dir, reason}}
    end
  end

  defp classify(name, basenames) do
    own = Enum.filter(basenames, &String.starts_with?(&1, name <> "@"))

    envelopes =
      for basename <- own, String.ends_with?(basename, @envelope_suffix) do
        {version_token(basename, name, @envelope_suffix), basename}
      end

    codes =
      for basename <- own, String.ends_with?(basename, @code_suffix) do
        {version_token(basename, name, @code_suffix), basename}
      end

    cond do
      envelopes == [] and codes == [] -> :not_found
      envelopes == [] -> {:error, {:missing_envelope, name}}
      true -> check_tokens(envelopes ++ codes, %{envelopes: envelopes, codes: codes})
    end
  end

  defp check_tokens(tokens, entries) do
    case Enum.find(tokens, fn {token, _basename} -> token == "" end) do
      nil -> {:ok, entries}
      {_token, basename} -> {:error, {:malformed_filename, basename}}
    end
  end

  defp version_token(basename, name, suffix) do
    basename
    |> String.replace_prefix(name <> "@", "")
    |> String.replace_suffix(suffix, "")
  end

  defp read_envelopes(dir, entries) do
    Enum.reduce_while(entries, {:ok, []}, fn {version, basename}, {:ok, acc} ->
      case read_envelope(dir, version, basename) do
        {:ok, entry} -> {:cont, {:ok, [entry | acc]}}
        {:error, _reason} = error -> {:halt, error}
      end
    end)
  end

  defp read_envelope(dir, version, basename) do
    path = Path.join(dir, basename)

    with {:ok, stat} <- stat(path, basename),
         {:ok, bytes} <- read(path, basename),
         {:ok, envelope} <- decode(bytes, basename) do
      {:ok, %{version: version, basename: basename, envelope: envelope, mtime: stat.mtime}}
    end
  end

  defp stat(path, basename) do
    case File.stat(path, time: :posix) do
      {:ok, stat} -> {:ok, stat}
      {:error, reason} -> {:error, {:unreadable, basename, reason}}
    end
  end

  defp read(path, basename) do
    case File.read(path) do
      {:ok, bytes} -> {:ok, bytes}
      {:error, reason} -> {:error, {:unreadable, basename, reason}}
    end
  end

  defp decode(bytes, basename) do
    case Jason.decode(bytes) do
      {:ok, %{} = envelope} -> {:ok, envelope}
      {:ok, _other} -> {:error, {:malformed_envelope, basename, :not_an_object}}
      {:error, reason} -> {:error, {:malformed_envelope, basename, reason}}
    end
  end

  defp unique_versions(envelopes) do
    case duplicates(Enum.map(envelopes, & &1.envelope["version"])) do
      [] -> :ok
      [version | _rest] -> {:error, {:duplicate_active_version, version}}
    end
  end

  defp duplicates(versions) do
    versions
    |> Enum.frequencies()
    |> Enum.filter(fn {_version, count} -> count > 1 end)
    |> Enum.map(fn {version, _count} -> version end)
    |> Enum.sort()
  end

  defp agree_with_filenames(envelopes, name) do
    Enum.reduce_while(envelopes, :ok, fn entry, :ok ->
      cond do
        entry.envelope["name"] != name ->
          {:halt, {:error, {:name_mismatch, entry.basename, entry.envelope["name"]}}}

        entry.envelope["version"] != entry.version ->
          {:halt, {:error, {:version_mismatch, entry.basename, entry.envelope["version"]}}}

        true ->
          {:cont, :ok}
      end
    end)
  end

  defp active_version(envelopes) do
    Enum.max_by(envelopes, fn entry -> {entry.mtime, entry.version} end)
  end

  defp read_code(dir, name, %{version: version}) do
    basename = "#{name}@#{version}#{@code_suffix}"

    case File.read(Path.join(dir, basename)) do
      {:ok, code} -> {:ok, code}
      {:error, :enoent} -> {:error, {:missing_code, name, version}}
      {:error, reason} -> {:error, {:unreadable, basename, reason}}
    end
  end
end
