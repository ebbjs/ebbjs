defmodule EbbServer.Bench.Baseline do
  @moduledoc """
  Reads the machine-readable block out of a previous `mix bench.actions`
  report.

  A baseline is a Markdown report, not a separate format: `Report` writes one
  `ebb-bench-results:v1` HTML comment containing the run configs and their
  metrics, and this module extracts it. Keeping the data inside the report
  means a baseline is the exact artefact a reviewer already has, with no
  second file to keep in sync.
  """

  @marker "ebb-bench-results:v1"
  @version 1
  @type t :: map()

  @doc """
  Loads and validates the machine block at `path`.
  """
  @spec load(Path.t()) :: {:ok, t()} | {:error, String.t()}
  def load(path) do
    case File.read(path) do
      {:ok, content} ->
        decode(content)

      {:error, reason} ->
        {:error, "cannot read baseline #{path}: #{:file.format_error(reason)}"}
    end
  end

  @doc """
  Extracts the machine block from report Markdown.
  """
  @spec decode(String.t()) :: {:ok, t()} | {:error, String.t()}
  def decode(content) when is_binary(content) do
    with {:ok, json} <- extract(content),
         {:ok, payload} <- decode_json(json),
         :ok <- validate(payload) do
      {:ok, payload}
    end
  end

  @doc """
  The measured passes recorded in a loaded baseline.
  """
  @spec runs(t()) :: [map()]
  def runs(%{"runs" => runs}) when is_list(runs), do: runs

  defp extract(content) do
    pattern =
      ~r/<!--\s*#{Regex.escape(@marker)}\s*\n(.*?)\n-->/s

    case Regex.run(pattern, content) do
      [_, json] ->
        {:ok, json}

      nil ->
        {:error,
         "no #{@marker} block found; the baseline must be a report written by this harness"}
    end
  end

  defp decode_json(json) do
    case Jason.decode(json) do
      {:ok, payload} -> {:ok, payload}
      {:error, error} -> {:error, "invalid baseline machine block: #{Exception.message(error)}"}
    end
  end

  defp validate(%{"schema" => "ebb-bench-results", "version" => @version, "runs" => runs})
       when is_list(runs),
       do: :ok

  defp validate(%{"version" => version}) when version != @version do
    {:error, "unsupported baseline version #{inspect(version)}; expected #{@version}"}
  end

  defp validate(%{"schema" => schema}) when schema != "ebb-bench-results" do
    {:error, "unsupported baseline schema #{inspect(schema)}"}
  end

  defp validate(_payload), do: {:error, "baseline machine block has no runs"}
end
