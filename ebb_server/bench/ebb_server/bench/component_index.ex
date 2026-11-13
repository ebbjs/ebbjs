defmodule EbbServer.Bench.ComponentIndex do
  @moduledoc """
  Write amplification of the component existence index at k = 2, 4, 8
  components per entity (#799), and the resident set of the keys the derived
  in-memory index holds (#849).

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

  The resident-set table is not a throughput run: it fills an ETS
  `:ordered_set` with the derived index's keys — a label interned to an
  integer, the id kept whole — at the #503 document-set row count and one
  order of magnitude above it, and reports both the table's allocated bytes
  and the process RSS delta.
  """

  alias EbbServer.Bench.{Boot, Options}
  alias EbbServer.Storage.{ComponentEntityIndex, Writer}

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
  # The #503 document set holds 10,000 documents; 100,000 is the headroom
  # check the resident-set gate extrapolates from.
  @resident_row_counts [10_000, 100_000]
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
  The in-memory index's resident set at the #503 document-set row count and
  one order of magnitude above it, at every k.

  Each row holds one model entry plus k component entries, keyed exactly as
  the derived index keys them (`{label_id, entity_id}`). Tables stay resident
  until every measurement is taken, so allocator page reuse from a deleted
  table cannot hide one fill's cost. `rss_bytes` is the process RSS delta
  across that fill; `ets_bytes` is the table's own allocator accounting and
  is the cleaner signal when page reuse still makes the former noisy.
  """
  @spec resident_set() :: [
          %{
            rows: pos_integer(),
            k: pos_integer(),
            entries: pos_integer(),
            labels: pos_integer(),
            entries_bytes: non_neg_integer(),
            labels_bytes: non_neg_integer(),
            rss_bytes: non_neg_integer() | nil
          }
        ]
  def resident_set do
    measurements = for rows <- @resident_row_counts, k <- @k_values, do: {rows, k}

    :erlang.garbage_collect()
    rss_before = rss_kb()

    {results, {tables, _rss}} =
      Enum.map_reduce(measurements, {[], rss_before}, fn {rows, k}, {tables, previous_rss} ->
        table_opts = resident_tables()
        ComponentEntityIndex.reset(table_opts)

        Enum.each(1..rows, fn seq ->
          ComponentEntityIndex.apply_ops(resident_ops(k, seq), table_opts)
        end)

        rss_after = rss_kb()
        {entries_table, labels_table} = ComponentEntityIndex.tables(table_opts)

        result = %{
          rows: rows,
          k: k,
          entries: :ets.info(entries_table, :size),
          labels: :ets.info(labels_table, :size) - 1,
          entries_bytes: table_bytes(entries_table),
          labels_bytes: table_bytes(labels_table),
          rss_bytes: rss_delta(previous_rss, rss_after)
        }

        {result, {[table_opts | tables], rss_after}}
      end)

    Enum.each(tables, fn opts ->
      {entries, labels} = ComponentEntityIndex.tables(opts)
      :ets.delete(entries)
      :ets.delete(labels)
    end)

    results
  end

  defp resident_tables do
    unique = :erlang.unique_integer([:positive])

    [
      component_index: :"component_index_bench_#{unique}",
      component_entity_labels: :"component_entity_labels_bench_#{unique}"
    ]
  end

  defp resident_ops(k, seq) do
    # A nanoid's width, so the resident set is the one the server would hold
    # rather than a benchmark-shortened key.
    entity_id = "todo_" <> String.duplicate("x", 16) <> Integer.to_string(seq)

    components = for field <- 1..k, do: {:put, {"todo/f#{field}", entity_id}}
    [{:put, {"todo", entity_id}} | components]
  end

  defp table_bytes(table), do: :ets.info(table, :memory) * :erlang.system_info(:wordsize)

  defp rss_delta(nil, _after_kb), do: nil
  defp rss_delta(_before_kb, nil), do: nil
  defp rss_delta(before_kb, after_kb), do: max(after_kb - before_kb, 0) * 1024

  defp rss_kb do
    case File.read("/proc/self/status") do
      {:ok, content} ->
        case Regex.run(~r/^VmRSS:\s+(\d+)\s+kB/m, content) do
          [_, kb] -> String.to_integer(kb)
          _ -> nil
        end

      _ ->
        nil
    end
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
      component("u_eg_ci_e_#{seq}", membership_id, "entityGroup/entity_id", :replace, %{
        "value" => entity_id
      }),
      component("u_eg_ci_g_#{seq}", membership_id, "entityGroup/group_id", :replace, %{
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
