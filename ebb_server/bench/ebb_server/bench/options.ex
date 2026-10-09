defmodule EbbServer.Bench.Options do
  @moduledoc """
  Parses and validates the `mix bench.actions` command line.

  Everything here is a pure function so the option surface (and the
  reproduction command the report prints) can be pinned without booting a
  storage tree.
  """

  @type tier :: :t0 | :t1 | :t2 | :t3
  @type durability :: :sync | :async
  @type distribution :: :spread | :hot

  @type t :: %__MODULE__{
          tier: tier(),
          duration: pos_integer(),
          warmup: non_neg_integer(),
          concurrency: pos_integer(),
          batch_size: pos_integer(),
          port: :inet.port_number(),
          seed: integer(),
          out: String.t() | nil,
          entities: non_neg_integer(),
          writers: pos_integer(),
          durability: durability(),
          distribution: distribution(),
          updates_per_action: pos_integer(),
          subscribers: non_neg_integer()
        }

  defstruct tier: :t0,
            duration: 10,
            warmup: 3,
            concurrency: 1,
            batch_size: 1,
            port: 4111,
            seed: 1,
            out: nil,
            entities: 0,
            writers: 1,
            durability: :sync,
            distribution: :spread,
            updates_per_action: 2,
            subscribers: 0

  @tiers %{"t0" => :t0, "t1" => :t1, "t2" => :t2, "t3" => :t3}
  @durabilities %{"sync" => :sync, "async" => :async}
  @distributions %{"spread" => :spread, "hot" => :hot}
  @updates_per_action [1, 2, 10]

  @switches [
    tier: :string,
    duration: :integer,
    warmup: :integer,
    concurrency: :integer,
    batch_size: :integer,
    port: :integer,
    seed: :integer,
    out: :string,
    entities: :integer,
    writers: :integer,
    durability: :string,
    distribution: :string,
    updates_per_action: :integer,
    subscribers: :integer
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
      {"Tier", "#{config.tier} (#{tier_description(config.tier)})"},
      {"Measured window", "#{config.duration}s"},
      {"Warmup", "#{config.warmup}s"},
      {"Concurrency", "#{config.concurrency}"},
      {"Actions per call/request", "#{config.batch_size}"},
      {"Updates per Action", "#{config.updates_per_action}"},
      {"Distribution", "#{config.distribution}"},
      {"Durability", "#{config.durability}"},
      {"Preloaded entities", "#{config.entities}"},
      {"SSE subscribers", "#{config.subscribers}"},
      {"Writers", "#{config.writers}"},
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
      "mix bench.actions",
      "--tier #{config.tier}",
      "--duration #{config.duration}",
      "--warmup #{config.warmup}",
      "--concurrency #{config.concurrency}",
      "--batch-size #{config.batch_size}",
      "--updates-per-action #{config.updates_per_action}",
      "--distribution #{config.distribution}",
      "--durability #{config.durability}",
      "--entities #{config.entities}",
      "--subscribers #{config.subscribers}",
      "--writers #{config.writers}",
      "--port #{config.port}",
      "--seed #{config.seed}"
    ]

    case config.out do
      nil -> Enum.join(base, " ")
      out -> Enum.join(base ++ ["--out #{out}"], " ")
    end
  end

  @doc """
  Short human label for a tier.
  """
  @spec tier_description(tier()) :: String.t()
  def tier_description(:t0), do: "Writer.write_actions/1, no HTTP"
  def tier_description(:t1), do: "POST /sync/actions, concurrency 1"
  def tier_description(:t2), do: "POST /sync/actions at requested concurrency"
  def tier_description(:t3), do: "T2 plus in-process SSE subscribers"

  defp apply_opts(opts, config) do
    Enum.reduce(opts, config, &put_opt/2)
  end

  defp put_opt({:tier, value}, acc), do: %{acc | tier: value}
  defp put_opt({:duration, value}, acc), do: %{acc | duration: value}
  defp put_opt({:warmup, value}, acc), do: %{acc | warmup: value}
  defp put_opt({:concurrency, value}, acc), do: %{acc | concurrency: value}
  defp put_opt({:batch_size, value}, acc), do: %{acc | batch_size: value}
  defp put_opt({:port, value}, acc), do: %{acc | port: value}
  defp put_opt({:seed, value}, acc), do: %{acc | seed: value}
  defp put_opt({:out, value}, acc), do: %{acc | out: value}
  defp put_opt({:entities, value}, acc), do: %{acc | entities: value}
  defp put_opt({:writers, value}, acc), do: %{acc | writers: value}
  defp put_opt({:durability, value}, acc), do: %{acc | durability: value}
  defp put_opt({:distribution, value}, acc), do: %{acc | distribution: value}
  defp put_opt({:updates_per_action, value}, acc), do: %{acc | updates_per_action: value}
  defp put_opt({:subscribers, value}, acc), do: %{acc | subscribers: value}

  defp validate(config) do
    with {:ok, tier} <- map_value(config.tier, @tiers, "tier"),
         {:ok, durability} <- map_value(config.durability, @durabilities, "durability"),
         {:ok, distribution} <- map_value(config.distribution, @distributions, "distribution"),
         :ok <- validate_ranges(config),
         :ok <- validate_tier(tier, config) do
      {:ok,
       apply_tier_constraints(%{
         config
         | tier: tier,
           durability: durability,
           distribution: distribution
       })}
    end
  end

  defp validate_ranges(config) do
    with :ok <- check(config.writers == 1, "--writers must be 1; multi-writer is gated on #287"),
         :ok <-
           check(
             config.updates_per_action in @updates_per_action,
             "--updates-per-action must be one of #{Enum.join(@updates_per_action, ", ")}"
           ),
         :ok <- check(config.duration > 0, "--duration must be a positive number of seconds"),
         :ok <- check(config.warmup >= 0, "--warmup must be zero or more seconds"),
         :ok <- check(config.concurrency > 0, "--concurrency must be at least 1"),
         :ok <- check(config.batch_size > 0, "--batch-size must be at least 1"),
         :ok <- check(config.entities >= 0, "--entities must be zero or more"),
         :ok <- check(config.port in 1..65_535, "--port must be a valid TCP port") do
      check(config.subscribers >= 0, "--subscribers must be zero or more")
    end
  end

  defp validate_tier(:t3, _config), do: :ok

  defp validate_tier(_tier, %{subscribers: 0}), do: :ok

  defp validate_tier(_tier, _config),
    do: {:error, "--subscribers is only supported with --tier t3"}

  # T1 exists to isolate per-request overhead with no queueing at the
  # Writer, so a concurrency argument cannot change it.
  defp apply_tier_constraints(%{tier: :t1} = config), do: %{config | concurrency: 1}
  defp apply_tier_constraints(config), do: config

  defp map_value(value, map, name) do
    case Map.fetch(map, to_string(value)) do
      {:ok, atom} ->
        {:ok, atom}

      :error ->
        {:error,
         "invalid #{name} #{inspect(value)}; expected one of #{Enum.join(Map.keys(map), ", ")}"}
    end
  end

  defp check(true, _message), do: :ok
  defp check(false, message), do: {:error, message}
end
