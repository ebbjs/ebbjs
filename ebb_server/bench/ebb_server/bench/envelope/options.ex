defmodule EbbServer.Bench.Envelope.Options do
  @moduledoc """
  Parses and validates the `mix bench.envelope` command line.

  The surface is deliberately small: which stored shapes to compare, which
  flush sizes to price the write leg at, how many Actions to seed for the
  read legs, and how many measured repetitions to take. Everything here is
  a pure function so the reproduction command can be pinned without booting
  a storage tree.
  """

  alias EbbServer.Bench.Envelope.Shapes

  @type t :: %__MODULE__{
          shapes: [Shapes.shape()],
          flush_sizes: [pos_integer()],
          reads: pos_integer(),
          updates_per_action: pos_integer(),
          runs: pos_integer(),
          port: :inet.port_number(),
          out: String.t() | nil
        }

  defstruct shapes: [:wrapper, :versioned_wrapper, :companion, :frame],
            flush_sizes: [100, 152],
            reads: 1000,
            updates_per_action: 2,
            runs: 3,
            port: 4212,
            out: nil

  @switches [
    shapes: :string,
    flush_sizes: :string,
    reads: :integer,
    updates_per_action: :integer,
    runs: :integer,
    port: :integer,
    out: :string
  ]

  # A flush larger than this is not an operating point anyone runs, and a
  # misspelled zero or negative would otherwise measure an empty batch.
  @max_flush_size 5_000

  # The largest Update count `EbbServer.Bench.Workbook` builds an Action for.
  @max_updates_per_action 10

  # The materialize read path samples a fixed-size GSN slice, so a run with
  # fewer seeded Actions than that cannot produce one full sample.
  @min_reads 16

  @doc """
  Parses `args` into a validated `t:t/0`.
  """
  @spec parse([String.t()]) :: {:ok, t()} | {:error, String.t()}
  def parse(args) do
    with {:ok, opts} <- parse_args(args),
         {:ok, shapes} <- shapes(Map.get(opts, :shapes)),
         {:ok, flush_sizes} <- ints(Map.get(opts, :flush_sizes), "--flush-sizes") do
      %__MODULE__{}
      |> put_parsed(shapes, flush_sizes)
      |> Map.merge(Map.drop(opts, [:shapes, :flush_sizes]))
      |> validate()
    end
  end

  @doc """
  A full markdown-friendly description of the effective configuration.
  """
  @spec describe(t()) :: [{String.t(), String.t()}]
  def describe(%__MODULE__{} = config) do
    [
      {"Shapes", Enum.map_join(config.shapes, ", ", &Atom.to_string/1)},
      {"Flush sizes (Actions)", Enum.join(config.flush_sizes, ", ")},
      {"Repetitions (--runs, a floor)",
       "#{config.runs}; the runner repeats to at least 51 write rounds per size, " <>
         "51 encode samples per shape, and 1,000 samples per read path"},
      {"Seeded Actions for the read legs", "#{config.reads}"},
      {"Updates per Action", "#{config.updates_per_action}"},
      {"Port", "#{config.port}"},
      {"Output", config.out || "(default)"}
    ]
  end

  @doc """
  The exact command that reproduces the run, with every option explicit.
  """
  @spec command(t()) :: String.t()
  def command(%__MODULE__{} = config) do
    base = [
      "mix bench.envelope",
      "--shapes #{Enum.map_join(config.shapes, ",", &Atom.to_string/1)}",
      "--flush-sizes #{Enum.join(config.flush_sizes, ",")}",
      "--reads #{config.reads}",
      "--updates-per-action #{config.updates_per_action}",
      "--runs #{config.runs}",
      "--port #{config.port}"
    ]

    case config.out do
      nil -> Enum.join(base, " ")
      out -> Enum.join(base ++ ["--out #{out}"], " ")
    end
  end

  defp parse_args(args) do
    case OptionParser.parse(args, strict: @switches) do
      {opts, [], []} ->
        {:ok, Map.new(opts)}

      {_opts, rest, []} ->
        {:error, "unexpected arguments: #{Enum.join(rest, " ")}"}

      {_opts, _rest, invalid} ->
        names = Enum.map_join(invalid, ", ", fn {name, _value} -> name end)
        {:error, "invalid options: #{names}"}
    end
  end

  defp put_parsed(config, nil, nil), do: config
  defp put_parsed(config, nil, flush_sizes), do: %{config | flush_sizes: flush_sizes}

  defp put_parsed(config, shapes, nil), do: %{config | shapes: shapes}

  defp put_parsed(config, shapes, flush_sizes),
    do: %{config | shapes: shapes, flush_sizes: flush_sizes}

  # Resolved against a fixed map rather than `String.to_existing_atom/1` so a
  # typo is a validation error, not a raised ArgumentError.
  defp shapes(nil), do: {:ok, nil}

  defp shapes(raw) do
    names = split(raw)
    known = Shapes.by_name()
    invalid = Enum.reject(names, &Map.has_key?(known, &1))

    cond do
      names == [] ->
        {:error, "--shapes must list at least one of #{shape_names()}"}

      invalid != [] ->
        {:error,
         "--shapes contains #{Enum.join(invalid, ", ")}; expected a subset of " <>
           shape_names()}

      true ->
        {:ok, names |> Enum.map(&Map.fetch!(known, &1)) |> Enum.uniq()}
    end
  end

  defp shape_names, do: Enum.join(Enum.sort(Map.keys(Shapes.by_name())), ", ")

  defp ints(nil, _flag), do: {:ok, nil}

  defp ints(raw, flag) do
    case split(raw) do
      [] ->
        {:error, "#{flag} must list at least one integer"}

      values ->
        parse_ints(values, flag)
    end
  end

  defp parse_ints(values, flag) do
    Enum.reduce_while(values, {:ok, []}, fn value, {:ok, acc} ->
      case Integer.parse(value) do
        {int, ""} -> {:cont, {:ok, [int | acc]}}
        _ -> {:halt, {:error, "#{flag} expects comma-separated integers, got #{inspect(value)}"}}
      end
    end)
    |> case do
      {:ok, acc} -> {:ok, acc |> Enum.reverse() |> Enum.uniq()}
      error -> error
    end
  end

  defp split(raw) do
    raw
    |> String.split(",")
    |> Enum.map(&String.trim/1)
    |> Enum.reject(&(&1 == ""))
  end

  defp validate(config) do
    with :ok <- check_non_empty(config.shapes, "--shapes must list at least one shape"),
         :ok <- check_non_empty(config.flush_sizes, "--flush-sizes must list at least one size"),
         :ok <- check_flush_sizes(config.flush_sizes),
         :ok <- check_reads(config.reads),
         :ok <- check_updates(config.updates_per_action),
         :ok <- check_runs(config.runs),
         :ok <- check(config.port in 1..65_535, "--port must be a valid TCP port") do
      {:ok, config}
    end
  end

  defp check_flush_sizes(sizes) do
    if Enum.all?(sizes, &(is_integer(&1) and &1 in 1..@max_flush_size)) do
      :ok
    else
      {:error, "--flush-sizes values must be integers between 1 and #{@max_flush_size}"}
    end
  end

  defp check_reads(reads) do
    check(
      is_integer(reads) and reads >= @min_reads,
      "--reads must be at least #{@min_reads}"
    )
  end

  defp check_updates(updates) do
    check(
      is_integer(updates) and updates in 1..@max_updates_per_action,
      "--updates-per-action must be between 1 and #{@max_updates_per_action}"
    )
  end

  defp check_runs(runs), do: check(is_integer(runs) and runs >= 1, "--runs must be at least 1")

  defp check_non_empty([], message), do: {:error, message}
  defp check_non_empty(_values, _message), do: :ok

  defp check(true, _message), do: :ok
  defp check(false, message), do: {:error, message}
end
