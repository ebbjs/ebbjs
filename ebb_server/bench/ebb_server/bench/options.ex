defmodule EbbServer.Bench.Options do
  @moduledoc """
  Parses and validates the `mix bench.actions` command line.

  Everything here is a pure function so the option surface (and the
  reproduction command the report prints) can be pinned without booting a
  storage tree.

  ## Ablation phases

  `--ablate` names writer phases the bench should skip, so a run can price
  each one by differencing against the full flush. The canonical order is
  the order reported and printed, regardless of how the flag was invoked;
  `all` expands to every phase. `:build` and `:encode` cover the pre-claim
  payload work, which runs in the Prepare pool: skipping `:build` stores an
  empty payload map, skipping `:encode` stores a precomputed ETF for a
  structurally valid empty Action so the record stays decodable by live
  readers.

  `t5` runs no Writer, so it honours only the phases that name an op group:
  `:dedup`, `:entity_actions`, `:type_entities` and `:group_index`. Ablating
  those drops the corresponding `cf_*` puts from the spike's batch, which is
  how the bench prices the stored shape of an Action (`--ablate
  dedup,entity_actions,type_entities,group_index` leaves a
  `cf_actions`-only batch).

  `:entity_index` is kept as the combined alias for the two halves of the
  entity index: it ablates both `cf_entity_actions` and `cf_type_entities`,
  so the earlier published reproduction commands keep meaning what they did.
  Use `:entity_actions` and `:type_entities` to price the halves apart.

  ## Pipeline depth

  `--in-flight` names how many `Writer.write_actions/1` calls each worker
  keeps outstanding. A list is a sweep: `EbbServer.Bench.Runner` runs one full
  measured pass per depth. Depth 1 is the original serial worker loop and the
  default on every tier; a real depth is only allowed where the caller drives
  the Writer (`t0`, `t2`, `t3`). Repeated depths collapse, so `2,2` is one
  single-depth run, not a sweep.

  Depth is both a workload knob and the Writer's `max_in_flight` (capped at
  4), so depth above one can prepare a successor against the predecessor's
  cache overlay (#533). It is not a promise of pipeline parallelism: the
  Writer coalesces outstanding calls, so a deeper workload also deepens the
  flush and costs more per Action. Read the report's `Actions/flush` column,
  and compare depths only at the same flush shape — the control tables in
  `ebb_server/bench/RESULTS.md` are what separates the two.

  ## Writer coalescing

  `--batch-timeout-ms` and `--batch-max-size` pass the Writer's coalescing
  policy straight through (`:batch_timeout_ms` and `:batch_max_size`, the
  same options the application env keys `:writer_batch_timeout_ms` and
  `:writer_batch_max_size` feed). The defaults here are the production
  defaults: a 0 ms timeout burst-drains the mailbox, and a 1,000-Action cap
  that only binds when a burst is deeper than the default flush shape.

  ## Fan-out connection sampling

  `--conn-sample-rate` sets the server's per-subscriber `conn_deliver`
  sample rate through the `:fanout_conn_sample_rate` application env in the
  bench VM: `0` turns the hop off, `1` samples every delivery, and `K > 1`
  samples 1 in `K`. The other fan-out hops are never sampled. It is legal on
  every tier and has no effect on one without subscribers.

  `--subscriber-count-only` is a fan-out measurement mode: the in-process
  subscriber counts `event: data` occurrences with `:binary.matches/2` and
  skips the per-frame split and lag decode. It keeps the delivery count
  correct while removing the consumer's CPU from the same 4-scheduler box,
  so a run can separate server fan-out cost from consumer cost. It is
  allowed only on `t3`/`t4` and cannot be combined with `--subscriber-lean`.
  """

  @type tier :: :t0 | :t1 | :t2 | :t3 | :t4 | :t5
  @type durability :: :sync | :async
  @type distribution :: :spread | :hot

  @type ablate_phase ::
          :dedup
          | :group_resolution
          | :build
          | :encode
          | :entity_actions
          | :type_entities
          | :entity_index
          | :group_index
          | :dirty
          | :cache
          | :watermark
          | :fanout

  @type t :: %__MODULE__{
          tier: tier(),
          duration: pos_integer(),
          warmup: non_neg_integer(),
          concurrency: pos_integer(),
          in_flight: [pos_integer()],
          batch_size: pos_integer(),
          port: :inet.port_number(),
          seed: integer(),
          out: String.t() | nil,
          entities: non_neg_integer(),
          writers: pos_integer(),
          durability: durability(),
          distribution: distribution(),
          updates_per_action: pos_integer(),
          subscribers: non_neg_integer(),
          rate: non_neg_integer(),
          batch_timeout_ms: non_neg_integer(),
          batch_max_size: pos_integer(),
          conn_sample_rate: non_neg_integer(),
          subscriber_lean: boolean(),
          subscriber_count_only: boolean(),
          ablate: [ablate_phase()],
          baseline: String.t() | nil,
          guardrails: boolean()
        }

  defstruct tier: :t0,
            duration: 10,
            warmup: 3,
            concurrency: 1,
            in_flight: [1],
            batch_size: 1,
            port: 4111,
            seed: 1,
            out: nil,
            entities: 0,
            writers: 1,
            durability: :sync,
            distribution: :spread,
            updates_per_action: 2,
            subscribers: 0,
            rate: 0,
            batch_timeout_ms: 0,
            batch_max_size: 1000,
            conn_sample_rate: 100,
            subscriber_lean: false,
            subscriber_count_only: false,
            ablate: [],
            baseline: nil,
            guardrails: true

  @tiers %{"t0" => :t0, "t1" => :t1, "t2" => :t2, "t3" => :t3, "t4" => :t4, "t5" => :t5}
  @durabilities %{"sync" => :sync, "async" => :async}
  @distributions %{"spread" => :spread, "hot" => :hot}
  @updates_per_action [1, 2, 10]

  # Canonical order for the parsed list and the printed command.
  @ablate_phases [
    :dedup,
    :group_resolution,
    :build,
    :encode,
    :entity_actions,
    :type_entities,
    :entity_index,
    :group_index,
    :dirty,
    :cache,
    :watermark,
    :fanout
  ]
  @ablate_by_name Map.new(@ablate_phases, &{Atom.to_string(&1), &1})
  # `t5` commits an op list instead of running the Writer, so only the phases
  # that name an op group mean anything there.
  @t5_op_phases [:dedup, :entity_actions, :type_entities, :entity_index, :group_index]

  @switches [
    tier: :string,
    duration: :integer,
    warmup: :integer,
    concurrency: :integer,
    in_flight: :string,
    batch_size: :integer,
    port: :integer,
    seed: :integer,
    out: :string,
    entities: :integer,
    writers: :integer,
    durability: :string,
    distribution: :string,
    updates_per_action: :integer,
    subscribers: :integer,
    rate: :integer,
    batch_timeout_ms: :integer,
    batch_max_size: :integer,
    conn_sample_rate: :integer,
    subscriber_lean: :boolean,
    subscriber_count_only: :boolean,
    ablate: :string,
    baseline: :string,
    guardrails: :boolean
  ]

  @doc """
  Parses `args` into a validated `t:t/0`.
  """
  @spec parse([String.t()]) :: {:ok, t()} | {:error, String.t()}
  def parse(args) do
    case OptionParser.parse(args, strict: @switches) do
      {opts, [], []} ->
        with {:ok, opts} <- parse_in_flight(opts) do
          opts
          |> apply_opts(%__MODULE__{})
          |> validate()
        end

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
      {"Calls in flight per worker", in_flight_description(config)},
      {"Actions per call/request", "#{config.batch_size}"},
      {"Updates per Action", "#{config.updates_per_action}"},
      {"Distribution", "#{config.distribution}"},
      {"Durability", "#{config.durability}"},
      {"Preloaded entities", "#{config.entities}"},
      {"SSE subscribers", "#{config.subscribers}"},
      {"Fan-out conn sample rate", conn_sample_rate_description(config.conn_sample_rate)},
      {"Target Actions/sec", target_rate(config.rate)},
      {"Writer batch timeout", batch_timeout_description(config)},
      {"Writer batch cap", "#{config.batch_max_size} Actions"},
      {"Writers", "#{config.writers}"},
      {"Ablated phases", ablated_description(config.ablate)},
      {"Guardrails", guardrails_description(config)},
      {"Baseline", config.baseline || "none"},
      {"Port", "#{config.port}"},
      {"Seed", "#{config.seed}"},
      {"Output", config.out || "(default)"}
    ] ++ lean_description(config)
  end

  defp lean_description(%{subscriber_count_only: true}) do
    [
      {"Subscriber mode",
       "count-only (frame count per chunk, no per-frame split or lag sampling)"}
    ]
  end

  defp lean_description(%{subscriber_lean: true}) do
    [{"Subscriber mode", "lean (per-subscriber counters, no lag sampling)"}]
  end

  defp lean_description(_config), do: []

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
      "--in-flight #{Enum.join(config.in_flight, ",")}",
      "--batch-size #{config.batch_size}",
      "--updates-per-action #{config.updates_per_action}",
      "--distribution #{config.distribution}",
      "--durability #{config.durability}",
      "--entities #{config.entities}",
      "--subscribers #{config.subscribers}",
      "--rate #{config.rate}",
      "--batch-timeout-ms #{config.batch_timeout_ms}",
      "--batch-max-size #{config.batch_max_size}",
      "--conn-sample-rate #{config.conn_sample_rate}",
      "--writers #{config.writers}",
      "--port #{config.port}",
      "--seed #{config.seed}"
    ]

    base = if config.subscriber_count_only, do: base ++ ["--subscriber-count-only"], else: base
    base = if config.subscriber_lean, do: base ++ ["--subscriber-lean"], else: base
    base = if config.guardrails, do: base, else: base ++ ["--no-guardrails"]

    base =
      if config.baseline, do: base ++ ["--baseline #{config.baseline}"], else: base

    base =
      case config.ablate do
        [] -> base
        phases -> base ++ ["--ablate #{Enum.map_join(phases, ",", &Atom.to_string/1)}"]
      end

    case config.out do
      nil -> Enum.join(base, " ")
      out -> Enum.join(base ++ ["--out #{out}"], " ")
    end
  end

  @doc """
  The workload fields that determine whether two runs are comparable.

  A `--baseline` comparison pairs a measured pass with a baseline pass only
  when these fields match. Duration and warmup are included because a shorter
  or colder window is not comparable; random seed, port, and output path are
  excluded because they do not change the shape of the load.
  """
  @spec workload(t()) :: map()
  def workload(%__MODULE__{} = config) do
    %{
      "tier" => Atom.to_string(config.tier),
      "duration" => config.duration,
      "warmup" => config.warmup,
      "concurrency" => config.concurrency,
      "in_flight" => config.in_flight,
      "batch_size" => config.batch_size,
      "updates_per_action" => config.updates_per_action,
      "distribution" => Atom.to_string(config.distribution),
      "durability" => Atom.to_string(config.durability),
      "entities" => config.entities,
      "subscribers" => config.subscribers,
      "subscriber_lean" => config.subscriber_lean,
      "subscriber_count_only" => config.subscriber_count_only,
      "rate" => config.rate,
      "ablate" => Enum.map(config.ablate, &Atom.to_string/1)
    }
  end

  @doc """
  Short human label for a tier.
  """
  @spec tier_description(tier()) :: String.t()
  def tier_description(:t0), do: "Writer.write_actions/1, no HTTP"
  def tier_description(:t1), do: "POST /sync/actions, concurrency 1"
  def tier_description(:t2), do: "POST /sync/actions at requested concurrency"
  def tier_description(:t3), do: "T2 plus in-process SSE subscribers"

  def tier_description(:t4),
    do: "fixed-rate Writer.write_actions/1 plus in-process SSE subscribers"

  def tier_description(:t5),
    do: "raw RocksDB.write_batch/3 from N concurrent callers, no Writer, --ablate names op groups"

  @doc """
  Whether the run drives the raw storage NIF instead of the Writer.
  """
  @spec bypasses_writer?(t()) :: boolean()
  def bypasses_writer?(%__MODULE__{tier: :t5}), do: true
  def bypasses_writer?(%__MODULE__{}), do: false

  @doc """
  The single call depth for a per-run configuration.

  `EbbServer.Bench.Runner` fans a sweep out into one config per depth, so a
  config that still names several depths is a scheduling mistake and raises
  rather than silently measuring one of them.
  """
  @spec depth(t()) :: pos_integer()
  def depth(%__MODULE__{in_flight: [depth]}), do: depth

  def depth(%__MODULE__{in_flight: depths}) do
    raise ArgumentError,
          "--in-flight must name exactly one depth for a single run, got: #{inspect(depths)}"
  end

  @doc """
  Whether watermark lag is meaningful for this run.

  The t5 spike writes raw batches at a synthetic per-caller GSN base and
  never commits through the Writer, so there is no frontier to compare
  against. Ablating `:watermark` likewise freezes the frontier.
  """
  @spec measures_frontier?(t()) :: boolean()
  def measures_frontier?(%__MODULE__{tier: :t5}), do: false
  def measures_frontier?(%__MODULE__{ablate: ablate}), do: :watermark not in ablate

  @doc """
  Whether a GSN density scan describes this run.

  The t5 spike writes at a synthetic per-caller GSN base, so a scan from
  GSN 1 would count the base itself as holes. Every Writer-driven tier is
  measurable, including with `:watermark` ablated: a hole is a missing
  `cf_actions` record and does not depend on how far the frontier moved.
  """
  @spec measures_gsn_density?(t()) :: boolean()
  def measures_gsn_density?(%__MODULE__{tier: :t5}), do: false
  def measures_gsn_density?(%__MODULE__{}), do: true

  @doc """
  Microseconds between batches a t4 worker paces to.

  This is the pacing contract for the fixed-rate tier: a worker that waits
  this long between `batch_size`-Action calls writes at `target_rate`
  Actions/sec. Returns whole microseconds, so a rate that does not divide
  the batch evenly rounds down; a rate high enough to round to zero is
  floored at one microsecond so pacing is never silently disabled.
  """
  @spec batch_interval_us(t()) :: pos_integer()
  def batch_interval_us(%__MODULE__{batch_size: batch_size, rate: rate}) when rate > 0 do
    max(div(batch_size * 1_000_000, rate), 1)
  end

  defp apply_opts(opts, config) do
    Enum.reduce(opts, config, &put_opt/2)
  end

  defp put_opt({:tier, value}, acc), do: %{acc | tier: value}
  defp put_opt({:duration, value}, acc), do: %{acc | duration: value}
  defp put_opt({:warmup, value}, acc), do: %{acc | warmup: value}
  defp put_opt({:concurrency, value}, acc), do: %{acc | concurrency: value}
  defp put_opt({:in_flight, value}, acc), do: %{acc | in_flight: value}
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
  defp put_opt({:rate, value}, acc), do: %{acc | rate: value}

  defp put_opt({:batch_timeout_ms, value}, acc),
    do: %{acc | batch_timeout_ms: value}

  defp put_opt({:batch_max_size, value}, acc), do: %{acc | batch_max_size: value}

  defp put_opt({:conn_sample_rate, value}, acc),
    do: %{acc | conn_sample_rate: value}

  defp put_opt({:subscriber_lean, value}, acc), do: %{acc | subscriber_lean: value}
  defp put_opt({:subscriber_count_only, value}, acc), do: %{acc | subscriber_count_only: value}
  defp put_opt({:ablate, value}, acc), do: %{acc | ablate: split_ablate(value)}
  defp put_opt({:baseline, value}, acc), do: %{acc | baseline: value}
  defp put_opt({:guardrails, value}, acc), do: %{acc | guardrails: value}

  defp validate(config) do
    with {:ok, tier} <- map_value(config.tier, @tiers, "tier"),
         {:ok, durability} <- map_value(config.durability, @durabilities, "durability"),
         {:ok, distribution} <- map_value(config.distribution, @distributions, "distribution"),
         {:ok, ablate} <- validate_ablate(config.ablate),
         :ok <- validate_in_flight(tier, config),
         :ok <- validate_ranges(config),
         :ok <- validate_tier(tier, config) do
      {:ok,
       apply_tier_constraints(%{
         config
         | tier: tier,
           durability: durability,
           distribution: distribution,
           ablate: ablate
       })}
    end
  end

  defp split_ablate(value) do
    value
    |> String.split(",")
    |> Enum.map(&String.trim/1)
    |> Enum.reject(&(&1 == ""))
  end

  # `--in-flight` is the only integer-list option, and an unparsable entry has
  # no way to report an error from `put_opt/2`, so the raw string is converted
  # here before the options are applied.
  defp parse_in_flight(opts) do
    case List.keyfind(opts, :in_flight, 0) do
      nil ->
        {:ok, opts}

      {:in_flight, raw} ->
        case parse_depths(raw) do
          {:ok, []} ->
            {:error, "--in-flight must name at least one depth"}

          {:ok, depths} ->
            {:ok, List.keyreplace(opts, :in_flight, 0, {:in_flight, Enum.uniq(depths)})}

          :error ->
            {:error,
             "--in-flight must be a comma-separated list of integers, got: #{inspect(raw)}"}
        end
    end
  end

  defp parse_depths(raw) do
    raw
    |> String.split(",")
    |> Enum.map(&String.trim/1)
    |> Enum.reject(&(&1 == ""))
    |> Enum.reduce_while({:ok, []}, fn value, {:ok, acc} ->
      case Integer.parse(value) do
        {depth, ""} -> {:cont, {:ok, [depth | acc]}}
        _ -> {:halt, :error}
      end
    end)
    |> case do
      {:ok, depths} -> {:ok, Enum.reverse(depths)}
      :error -> :error
    end
  end

  defp in_flight_description(%{in_flight: depths}) when length(depths) > 1,
    do: Enum.join(depths, ", ") <> " (sweep)"

  defp in_flight_description(%{in_flight: depths}), do: Enum.join(depths, ", ")

  # `all` is a convenience for the whole phase set; otherwise every name
  # must be known. The result is in canonical order so the printed
  # command is stable regardless of how the run was invoked.
  defp validate_ablate([]), do: {:ok, []}

  defp validate_ablate(names) do
    if "all" in names do
      {:ok, @ablate_phases}
    else
      names
      |> Enum.map(&Map.fetch(@ablate_by_name, &1))
      |> collect_ablate(names)
    end
  end

  defp collect_ablate(fetched, names) do
    case Enum.find_index(fetched, &(&1 == :error)) do
      nil ->
        {:ok, fetched |> Enum.map(&elem(&1, 1)) |> Enum.uniq() |> canonical_ablate()}

      index ->
        {:error,
         "invalid --ablate phase #{inspect(Enum.at(names, index))}; " <>
           "expected one of all, #{Enum.join(Map.keys(@ablate_by_name), ", ")}"}
    end
  end

  defp canonical_ablate(phases), do: Enum.filter(@ablate_phases, &(&1 in phases))

  defp ablated_description([]), do: "none"
  defp ablated_description(phases), do: Enum.map_join(phases, ", ", &Atom.to_string/1)

  defp guardrails_description(%{guardrails: true}), do: "enforced"
  defp guardrails_description(%{guardrails: false}), do: "disabled (--no-guardrails)"

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
         :ok <- check(config.port in 1..65_535, "--port must be a valid TCP port"),
         :ok <- check(config.subscribers >= 0, "--subscribers must be zero or more"),
         :ok <- check(config.batch_timeout_ms >= 0, "--batch-timeout-ms must be zero or more"),
         :ok <- check(config.batch_max_size > 0, "--batch-max-size must be at least 1"),
         :ok <- check(config.conn_sample_rate >= 0, "--conn-sample-rate must be zero or more") do
      check(config.rate >= 0, "--rate must be zero or more Actions/sec")
    end
  end

  defp validate_tier(tier, config) do
    with :ok <- validate_rate(tier, config),
         :ok <- validate_tier_concurrency(tier, config),
         :ok <- validate_subscribers(tier, config),
         :ok <- validate_tier_ablate(tier, config) do
      with :ok <- validate_lean(tier, config) do
        validate_count_only(tier, config)
      end
    end
  end

  # Depth 1 is the untouched serial loop, so it is legal on every tier. A
  # real depth is only meaningful where the caller drives the Writer: t1 and
  # t4 are single-producer by construction, and t5 never enters the Writer.
  defp validate_in_flight(tier, config) do
    with :ok <- check_positive_depths(config.in_flight) do
      check_in_flight_tier(tier, config.in_flight)
    end
  end

  defp check_positive_depths(depths) do
    check(
      Enum.all?(depths, &(is_integer(&1) and &1 > 0)),
      "--in-flight values must be positive integers"
    )
  end

  defp check_in_flight_tier(_tier, [1]), do: :ok
  defp check_in_flight_tier(tier, _depths) when tier in [:t0, :t2, :t3], do: :ok

  defp check_in_flight_tier(:t1, _depths),
    do: {:error, "--in-flight is not supported with --tier t1; the tier is single-producer HTTP"}

  defp check_in_flight_tier(:t4, _depths),
    do: {:error, "--in-flight is not supported with --tier t4; pacing is single-producer"}

  defp check_in_flight_tier(:t5, _depths),
    do: {:error, "--in-flight is not supported with --tier t5; the spike bypasses the Writer"}

  defp validate_rate(:t4, %{rate: rate}) when rate > 0, do: :ok
  defp validate_rate(:t4, _config), do: {:error, "--tier t4 requires --rate > 0 (Actions/sec)"}
  defp validate_rate(_tier, %{rate: 0}), do: :ok
  defp validate_rate(_tier, _config), do: {:error, "--rate is only supported with --tier t4"}

  defp validate_tier_concurrency(:t4, %{concurrency: 1}), do: :ok

  defp validate_tier_concurrency(:t4, _config),
    do: {:error, "--tier t4 requires --concurrency 1; pacing is per single producer"}

  defp validate_tier_concurrency(_tier, _config), do: :ok

  defp validate_subscribers(:t3, _config), do: :ok
  defp validate_subscribers(:t4, _config), do: :ok
  defp validate_subscribers(_tier, %{subscribers: 0}), do: :ok

  defp validate_subscribers(_tier, _config),
    do: {:error, "--subscribers is only supported with --tier t3 or t4"}

  defp validate_lean(:t3, _config), do: :ok
  defp validate_lean(:t4, _config), do: :ok
  defp validate_lean(_tier, %{subscriber_lean: false}), do: :ok

  defp validate_lean(_tier, _config),
    do: {:error, "--subscriber-lean is only supported with --tier t3 or t4"}

  defp validate_count_only(:t3, %{subscriber_count_only: true, subscriber_lean: true}),
    do: {:error, "--subscriber-count-only cannot be combined with --subscriber-lean"}

  defp validate_count_only(:t4, %{subscriber_count_only: true, subscriber_lean: true}),
    do: {:error, "--subscriber-count-only cannot be combined with --subscriber-lean"}

  defp validate_count_only(:t3, _config), do: :ok
  defp validate_count_only(:t4, _config), do: :ok
  defp validate_count_only(_tier, %{subscriber_count_only: false}), do: :ok

  defp validate_count_only(_tier, _config),
    do: {:error, "--subscriber-count-only is only supported with --tier t3 or t4"}

  # Ablation removes Writer phases from the flush critical path; t5 builds the
  # op list itself, so only the phases that name an op group apply.
  # Phase names arrive as strings here; `validate_ablate/1` normalises them to
  # atoms after the tier checks, so compare by name.
  defp validate_tier_ablate(:t5, %{ablate: ablate}) do
    supported = Enum.map(@t5_op_phases, &Atom.to_string/1)

    case Enum.reject(ablate, &(to_string(&1) in supported)) do
      [] ->
        :ok

      unsupported ->
        {:error,
         "--ablate #{Enum.map_join(unsupported, ",", &to_string/1)} is not supported with " <>
           "--tier t5; it runs no Writer (supported: #{Enum.map_join(supported, ",", & &1)})"}
    end
  end

  defp validate_tier_ablate(_tier, _config), do: :ok

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

  defp conn_sample_rate_description(0), do: "off"
  defp conn_sample_rate_description(1), do: "every delivery"
  defp conn_sample_rate_description(rate), do: "1 in #{rate}"

  defp target_rate(0), do: "unpaced"
  defp target_rate(rate), do: "#{rate}"

  defp batch_timeout_description(%{batch_timeout_ms: 0}), do: "0 ms (burst drain)"
  defp batch_timeout_description(%{batch_timeout_ms: ms}), do: "#{ms} ms"
end
