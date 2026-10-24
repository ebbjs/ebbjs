defmodule EbbServer.Bench.Materialize.Options do
  @moduledoc """
  Parses and validates the `mix bench.materialize` command line.

  Kept separate from `EbbServer.Bench.Options` (the write-path switch
  surface) because a read benchmark varies document size and result count,
  not batch size and durability. Everything here is a pure function so the
  reproduction command can be pinned without booting a storage tree.
  """

  @type distribution :: :hot | :spread
  @type scenario :: :cold | :dirty | :clean | :query

  @type t :: %__MODULE__{
          sizes: [pos_integer()],
          runs: pos_integer(),
          reps: pos_integer(),
          spread_entities: pos_integer(),
          query_ks: [pos_integer()],
          history_sizes: [non_neg_integer()],
          scenarios: [scenario()],
          distributions: [distribution()],
          run_value_bytes: pos_integer(),
          port: :inet.port_number(),
          seed: integer(),
          out: String.t() | nil
        }

  defstruct sizes: [100, 500, 1000, 2000, 5000],
            runs: 3,
            reps: 50,
            spread_entities: 50,
            query_ks: [1, 10, 50],
            history_sizes: [],
            scenarios: [:cold, :dirty, :clean, :query],
            distributions: [:hot, :spread],
            run_value_bytes: 130,
            port: 4211,
            seed: 1,
            out: nil

  @scenarios [:cold, :dirty, :clean, :query]
  @distributions [:hot, :spread]

  @switches [
    sizes: :string,
    runs: :integer,
    reps: :integer,
    spread_entities: :integer,
    query_ks: :string,
    history_sizes: :string,
    scenarios: :string,
    distributions: :string,
    run_value_bytes: :integer,
    port: :integer,
    seed: :integer,
    out: :string
  ]

  @doc """
  Parses `args` into a validated `t:t/0`.
  """
  @spec parse([String.t()]) :: {:ok, t()} | {:error, String.t()}
  def parse(args) do
    case OptionParser.parse(args, strict: @switches) do
      {opts, [], []} ->
        opts
        |> apply_opts(%__MODULE__{})
        |> validate()

      {_opts, rest, []} ->
        {:error, "unexpected arguments: #{Enum.join(rest, " ")}"}

      {_opts, _rest, invalid} ->
        names = Enum.map_join(invalid, ", ", fn {name, _value} -> name end)
        {:error, "invalid options: #{names}"}
    end
  end

  @doc """
  A full markdown-friendly description of the effective configuration.
  """
  @spec describe(t()) :: [{String.t(), String.t()}]
  def describe(%__MODULE__{} = config) do
    [
      {"Document sizes (run keys)", Enum.join(config.sizes, ", ")},
      {"Runs (boots, medians across them)", "#{config.runs}"},
      {"Repetitions per scenario", "#{config.reps}"},
      {"Spread entities per size", "#{config.spread_entities}"},
      {"Query result sizes", Enum.join(config.query_ks, ", ")},
      {"Entity histories (prior Updates)", history_sizes(config)},
      {"Scenarios", Enum.map_join(config.scenarios, ", ", &Atom.to_string/1)},
      {"Distributions", Enum.map_join(config.distributions, ", ", &Atom.to_string/1)},
      {"Run value size", "#{config.run_value_bytes} B"},
      {"Port", "#{config.port}"},
      {"Seed", "#{config.seed}"},
      {"Output", config.out || "(default)"}
    ]
  end

  @doc """
  The exact command that reproduces the run, with every option explicit.
  """
  @spec command(t()) :: String.t()
  def command(%__MODULE__{} = config) do
    base = [
      "mix bench.materialize",
      "--sizes #{Enum.join(config.sizes, ",")}",
      "--runs #{config.runs}",
      "--reps #{config.reps}",
      "--spread-entities #{config.spread_entities}",
      "--query-ks #{Enum.join(config.query_ks, ",")}",
      "--history-sizes #{Enum.join(config.history_sizes, ",")}",
      "--scenarios #{Enum.map_join(config.scenarios, ",", &Atom.to_string/1)}",
      "--distributions #{Enum.map_join(config.distributions, ",", &Atom.to_string/1)}",
      "--run-value-bytes #{config.run_value_bytes}",
      "--port #{config.port}",
      "--seed #{config.seed}"
    ]

    case config.out do
      nil -> Enum.join(base, " ")
      out -> Enum.join(base ++ ["--out #{out}"], " ")
    end
  end

  defp apply_opts(opts, config) do
    Enum.reduce(opts, config, &put_opt/2)
  end

  defp put_opt({:sizes, value}, acc), do: %{acc | sizes: split_ints(value)}
  defp put_opt({:runs, value}, acc), do: %{acc | runs: value}
  defp put_opt({:reps, value}, acc), do: %{acc | reps: value}
  defp put_opt({:spread_entities, value}, acc), do: %{acc | spread_entities: value}
  defp put_opt({:query_ks, value}, acc), do: %{acc | query_ks: split_ints(value)}
  defp put_opt({:history_sizes, value}, acc), do: %{acc | history_sizes: split_ints(value)}
  defp put_opt({:scenarios, value}, acc), do: %{acc | scenarios: split_atoms(value)}
  defp put_opt({:distributions, value}, acc), do: %{acc | distributions: split_atoms(value)}
  defp put_opt({:run_value_bytes, value}, acc), do: %{acc | run_value_bytes: value}
  defp put_opt({:port, value}, acc), do: %{acc | port: value}
  defp put_opt({:seed, value}, acc), do: %{acc | seed: value}
  defp put_opt({:out, value}, acc), do: %{acc | out: value}

  defp split_ints(value) do
    value
    |> String.split(",")
    |> Enum.map(&String.trim/1)
    |> Enum.reject(&(&1 == ""))
    |> Enum.map(&String.to_integer/1)
  end

  defp split_atoms(value) do
    value
    |> String.split(",")
    |> Enum.map(&String.trim/1)
    |> Enum.reject(&(&1 == ""))
    |> Enum.map(&String.to_existing_atom/1)
  end

  defp validate(config) do
    with :ok <- check_positive(config.runs, "--runs must be at least 1"),
         :ok <- check_positive(config.reps, "--reps must be at least 1"),
         :ok <- check_positive(config.spread_entities, "--spread-entities must be at least 1"),
         :ok <- check_positive(config.run_value_bytes, "--run-value-bytes must be at least 1"),
         :ok <- check_non_empty(config.sizes, "--sizes must list at least one size"),
         :ok <- check_history_sizes(config.history_sizes),
         :ok <- check_members(config.scenarios, @scenarios, "--scenarios"),
         :ok <- check_members(config.distributions, @distributions, "--distributions"),
         :ok <- check_all_positive(config.sizes, "--sizes"),
         :ok <- check_all_positive(config.query_ks, "--query-ks"),
         :ok <- check(config.port in 1..65_535, "--port must be a valid TCP port") do
      {:ok, normalize(config)}
    end
  end

  # A query cannot return more rows than the spread pool seeds.
  defp normalize(config) do
    ks = Enum.filter(config.query_ks, &(&1 <= config.spread_entities))
    %{config | query_ks: if(ks == [], do: [1], else: ks)}
  end

  defp check_members(values, allowed, flag) do
    invalid = Enum.reject(values, &(&1 in allowed))

    if invalid == [] do
      :ok
    else
      {:error,
       "#{flag} contains #{Enum.map_join(invalid, ", ", &inspect/1)}; " <>
         "expected a subset of #{Enum.map_join(allowed, ", ", &Atom.to_string/1)}"}
    end
  end

  defp check_all_positive(values, flag) do
    if Enum.all?(values, &(is_integer(&1) and &1 > 0)) do
      :ok
    else
      {:error, "#{flag} values must be positive integers"}
    end
  end

  # Seeding a very long history is minutes of writes, so the ceiling is here
  # to catch a typo rather than to bound a legitimate run.
  @max_history 1_000_000

  defp check_history_sizes(sizes) do
    if Enum.all?(sizes, &(is_integer(&1) and &1 in 0..@max_history)) do
      :ok
    else
      {:error, "--history-sizes values must be integers between 0 and #{@max_history}"}
    end
  end

  defp history_sizes(config) do
    case config.history_sizes do
      [] -> "none (history axis off)"
      sizes -> Enum.join(sizes, ", ")
    end
  end

  defp check_non_empty([], message), do: {:error, message}
  defp check_non_empty(_values, _message), do: :ok

  defp check_positive(value, _message) when is_integer(value) and value > 0, do: :ok
  defp check_positive(_value, message), do: {:error, message}

  defp check(true, _message), do: :ok
  defp check(false, message), do: {:error, message}
end
