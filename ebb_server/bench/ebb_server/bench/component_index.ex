defmodule EbbServer.Bench.ComponentIndex do
  @moduledoc """
  Write amplification of `cf_component_entities` at k = 2, 4, 8 components
  per entity (#799).

  Each measured Action creates one `todo` row carrying k components and one
  `entityGroup` row filing it into the bench group. That is the canonical
  unit the other benches use, extended to k components, and it keeps every
  Action deliverable: the membership row carries the group on the wire, and
  the todo row inherits it through the Action's intra-action membership.

  A row with k components costs k component entries plus the one model entry
  `EntityTypeCache` resolves, so this module reports both the index op count
  and the bytes those keys add. Throughput is measured through the real
  `Writer` (sync durability, no HTTP) with the index enabled and with
  `--ablate component_entities`, so the difference is the index's share of
  the commit cost rather than a storage primitive's.
  """

  alias EbbServer.Bench.{Boot, Options}
  alias EbbServer.Storage.{RocksDB, Writer}

  @k_values [2, 4, 8]
  @runs 5
  @concurrency 8
  # A fixed workload, not a fixed window: a 5 s window makes the arm that is
  # slower to commit also the arm with less time left when compaction lands,
  # so paired runs drift. Both arms write the same number of Actions and the
  # elapsed time is the measurement.
  @action_budget 20_000
  @warmup_actions 2_000
  @batch_size 25
  @port 4971

  @type measurement :: %{
          actions: non_neg_integer(),
          elapsed_ms: non_neg_integer(),
          actions_per_s: float()
        }

  @doc """
  Median actions/s for each k, with and without the component index.
  """
  @spec report() :: [
          %{
            k: pos_integer(),
            index: %{ops: pos_integer(), bytes: pos_integer()},
            baseline: [measurement()],
            indexed: [measurement()],
            ablated: [measurement()]
          }
        ]
  def report do
    for k <- @k_values do
      warmup = build_actions(k, @warmup_actions)
      actions = build_actions(k, @action_budget, @warmup_actions)

      # Interleave the arms inside one run pass: a slow drift (compaction or
      # CPU frequency) then lands on all three arms instead of biasing
      # whichever arm ran later.
      runs =
        for _ <- 1..@runs do
          %{
            baseline: measure([:component_entries], warmup, actions),
            indexed: measure([], warmup, actions),
            ablated: measure([:component_entities], warmup, actions)
          }
        end

      %{
        k: k,
        index: index_shape(k),
        baseline: Enum.map(runs, & &1.baseline),
        indexed: Enum.map(runs, & &1.indexed),
        ablated: Enum.map(runs, & &1.ablated)
      }
    end
  end

  @doc """
  One measured window: boot, warm the path with `warmup`, then time writing
  `actions` through the `Writer` at `@concurrency` callers.
  """
  @spec measure(pos_integer(), [atom()]) :: measurement()
  def measure(k, ablate) do
    measure(
      ablate,
      build_actions(k, @warmup_actions),
      build_actions(k, @action_budget, @warmup_actions)
    )
  end

  @spec measure([atom()], [map()], [map()]) :: measurement()
  def measure(ablate, warmup, actions) do
    config = %Options{
      tier: :t0,
      duration: 1,
      warmup: 0,
      concurrency: @concurrency,
      batch_size: 1,
      ablate: ablate,
      port: @port
    }

    boot = Boot.start(config)

    try do
      run_workers(warmup)
      run_workers(actions)
    after
      Boot.stop(boot)
    end
  end

  @doc """
  The per-entity index cost of a k-component row: k component entries and
  the bytes of their keys. The membership row an Action also writes is not
  part of the entity's amplification.
  """
  @spec index_shape(pos_integer()) :: %{ops: pos_integer(), bytes: pos_integer()}
  def index_shape(k) do
    # Same id width as a nanoid, so the key bytes report the real shape rather
    # than a benchmark-shortened id.
    entity_id = "todo_" <> String.duplicate("x", 21)

    keys =
      for field <- 1..k do
        RocksDB.encode_component_entity_key("todo/f#{field}", entity_id)
      end

    %{ops: k, bytes: keys |> Enum.map(&byte_size/1) |> Enum.sum()}
  end

  @doc """
  Builds `count` Actions, each a k-component `todo` row plus its membership.
  """
  @spec build_actions(pos_integer(), non_neg_integer(), non_neg_integer()) :: [map()]
  def build_actions(k, count, offset \\ 0) do
    for seq <- (offset + 1)..(offset + count) do
      build_action(k, seq)
    end
  end

  @doc """
  One validated Action creating a k-component `todo` row and its
  `entityGroup` row.
  """
  @spec build_action(pos_integer(), integer()) :: map()
  def build_action(k, seq) do
    hlc = System.os_time(:millisecond) * 65_536
    entity_id = "todo_ci_#{seq}"
    membership_id = "eg_ci_#{seq}"

    todo =
      for field <- 1..k do
        component("u_ci_#{seq}_#{field}", entity_id, "todo/f#{field}", :replace, %{
          "value" => "#{seq}-#{field}"
        })
      end

    membership = [
      component("u_eg_ci_e_#{seq}", membership_id, "entityGroup/entity_id", "replace", %{
        "value" => entity_id
      }),
      component("u_eg_ci_g_#{seq}", membership_id, "entityGroup/group_id", "replace", %{
        "value" => "g_bench"
      })
    ]

    %{
      id: "a_ci_#{seq}",
      actor_id: "a_bench",
      hlc: hlc,
      updates: todo ++ membership
    }
  end

  defp component(id, subject_id, component, method, data) do
    [model, field] = String.split(component, "/", parts: 2)

    %{
      id: id,
      subject_id: subject_id,
      component: component,
      model: model,
      field: field,
      method: method,
      data: data
    }
  end

  defp run_workers(actions) do
    slices = Enum.chunk_every(actions, ceil(length(actions) / @concurrency))
    started = System.monotonic_time(:millisecond)

    counts =
      slices
      |> Task.async_stream(&run_slice/1, max_concurrency: @concurrency, timeout: :infinity)
      |> Enum.map(fn {:ok, count} -> count end)

    elapsed = max(System.monotonic_time(:millisecond) - started, 1)
    actions = Enum.sum(counts)

    %{
      actions: actions,
      elapsed_ms: elapsed,
      actions_per_s: actions * 1_000 / elapsed
    }
  end

  defp run_slice(actions) do
    actions
    |> Enum.chunk_every(@batch_size)
    |> Enum.each(&write!/1)

    length(actions)
  end

  defp write!(actions) do
    case Writer.write_actions(actions) do
      {:ok, _range, []} -> :ok
      {:ok, _range, rejected} -> raise "bench action rejected: #{inspect(rejected)}"
      {:error, reason} -> raise "bench write failed: #{inspect(reason)}"
    end
  end
end
