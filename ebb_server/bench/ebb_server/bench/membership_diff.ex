defmodule EbbServer.Bench.MembershipDiff do
  @moduledoc """
  Spike-only H2 harness (#844, D2): does `as_of: gsn` entity→group resolution
  reproduce what the Writer persists?

  The corpus is generated and written through the **real Writer**, so the
  stored `update_scopes` in `cf_actions` are ground truth. The same Actions are
  folded into an `EbbServer.Storage.LogFirst.MembershipIndex` at the GSN the
  Writer assigned, and every Update's scope is resolved from the index at that
  GSN. A mismatch is a case resolution cannot leave the sequencer for; the
  report names the op that produced it.

  The corpus covers the concurrent-membership cases H2 calls out: create an
  entity and file it in the same Action, file an existing entity into a second
  group, move an entity between groups in one Action, delete a membership, and
  plain field updates. All Actions are single-request and sequential; the pool
  measurement then shows the resolver's cost when it runs off the serial path.

  Nothing here is wired into the write path.
  """

  alias EbbServer.Bench.{Boot, Options, Workbook}

  alias EbbServer.Storage.{
    ActionFormat,
    ActionValidator,
    CacheTables,
    EntityIndex,
    RocksDB,
    Writer
  }

  alias EbbServer.Storage.LogFirst.MembershipIndex

  @group2 "g_bench_second"
  @rate_samples 200_000
  @rate_workers 4

  @doc """
  Runs the corpus and returns the report map.
  """
  @spec run(keyword()) :: map()
  def run(opts \\ []) do
    steps = Keyword.get(opts, :steps, 120)
    seed = Keyword.get(opts, :seed, 1)
    trace = Keyword.get(opts, :trace)

    {:ok, config} =
      Options.parse([
        "--tier",
        "t0",
        "--duration",
        "1",
        "--warmup",
        "0",
        "--concurrency",
        "1",
        "--batch-size",
        "1",
        "--updates-per-action",
        "2",
        "--distribution",
        "hot",
        "--port",
        "4194"
      ])

    boot = Boot.start(config)

    try do
      ctx = Workbook.seed(config)
      write!(second_group_action(ctx))

      :rand.seed(:exsss, {seed, seed * 3, seed * 7})

      {state, world, results} =
        Enum.reduce(
          1..steps,
          {MembershipIndex.new(), Map.put(new_world(), :trace, trace), []},
          fn step, acc ->
            do_step(step, acc)
          end
        )

      report = %{
        steps: steps,
        committed: length(results),
        mismatches: Enum.reject(results, &(&1.match == :same)),
        match_counts: results |> Enum.frequencies_by(& &1.match),
        index: MembershipIndex.stats(state),
        rate: rate(state, world),
        prune: prune_check(state)
      }

      print(report)
      report
    after
      Boot.stop(boot)
    end
  end

  defp do_step(step, {state, world, results}) do
    {op, world, updates} = next_op(step, world)
    trace = Map.get(world, :trace)

    action = %{
      "id" => "a_diff_#{step}_#{:erlang.unique_integer([:positive])}",
      "actor_id" => Workbook.actor_id(),
      "hlc" => hlc(),
      "updates" => updates
    }

    validated = ActionValidator.to_validated_action(action)

    case Writer.write_actions([validated]) do
      {:ok, {_first, last}, []} ->
        state = MembershipIndex.apply_action(state, last, updates)
        stored = stored_scopes(last)
        result = compare(step, op, updates, last, stored, state)

        if trace && touches?(updates, trace) do
          IO.puts("TRACE step=#{step} op=#{inspect(op)}")
          IO.puts("  updates:  #{inspect(updates)}")
          IO.puts("  stored:   #{inspect(stored)}")
          IO.puts("  resolved: #{inspect(resolve(state, updates, last))}")

          rows = MembershipIndex.get(state, {:rows, trace}, last) || MapSet.new()

          IO.puts("  model: #{inspect(MembershipIndex.get(state, {:model, trace}, last))}")
          IO.puts("  rows:  #{inspect(Enum.sort(MapSet.to_list(rows)))}")

          for row <- Enum.sort(MapSet.to_list(rows)) do
            IO.puts(
              "    #{row} -> #{inspect(MembershipIndex.get(state, {:membership, row}, last))}"
            )
          end
        end

        {state, apply_world(world, op), [result | results]}

      {:ok, {_first, _last}, rejected} ->
        raise "corpus Action rejected (#{op}): #{inspect(rejected)}"

      {:error, reason} ->
        raise "corpus write failed (#{op}): #{inspect(reason)}"
    end
  end

  # -- corpus ---------------------------------------------------------------

  defp new_world, do: %{entities: %{}, rows: %{}}

  defp next_op(step, world) do
    case :rand.uniform(10) do
      n when n <= 3 -> create_op(step, world)
      n when n <= 5 -> add_op(step, world)
      n when n <= 7 -> move_op(step, world)
      8 -> remove_op(step, world)
      _ -> update_op(step, world)
    end
  end

  defp create_op(step, world) do
    entity = "todo_diff_#{step}"
    row = "eg_diff_#{step}"
    group = group()

    updates = [
      todo(entity, "title", "c#{step}"),
      todo(entity, "bench_sent_us", step),
      membership_field(row, "entity_id", entity),
      membership_field(row, "group_id", group)
    ]

    {{:create, entity, row, group}, world, updates}
  end

  defp add_op(step, world) do
    case pick_entity(world) do
      nil ->
        create_op(step, world)

      {entity, %{groups: groups}} ->
        group = Enum.find(["g_bench", @group2], &(not MapSet.member?(groups, &1))) || "g_bench"
        row = "eg_diff_#{step}"

        {{:add, entity, row, group}, world,
         [
           membership_field(row, "entity_id", entity),
           membership_field(row, "group_id", group)
         ]}
    end
  end

  defp move_op(step, world) do
    case pick_row(world) do
      nil ->
        add_op(step, world)

      {row, {entity, from}} ->
        to = if from == "g_bench", do: @group2, else: "g_bench"
        new_row = "eg_diff_#{step}"

        {{:move, entity, new_row, to, row}, world,
         [
           %{"id" => "u_del_#{step}", "subject_id" => row, "method" => "delete", "data" => nil},
           membership_field(new_row, "entity_id", entity),
           membership_field(new_row, "group_id", to)
         ]}
    end
  end

  defp remove_op(step, world) do
    case pick_row(world) do
      nil ->
        update_op(step, world)

      {row, _} ->
        {{:remove, nil, row, nil}, world,
         [%{"id" => "u_del_#{step}", "subject_id" => row, "method" => "delete", "data" => nil}]}
    end
  end

  defp update_op(step, world) do
    case pick_entity(world) do
      nil ->
        create_op(step, world)

      {entity, _groups} ->
        {{:update, entity, nil, nil}, world, [todo(entity, "title", "u#{step}")]}
    end
  end

  defp group, do: Enum.random(["g_bench", @group2])

  defp pick_entity(world) do
    case Map.to_list(world.entities) do
      [] -> nil
      entities -> Enum.random(entities)
    end
  end

  defp pick_row(world) do
    case Map.to_list(world.rows) do
      [] -> nil
      rows -> Enum.random(rows)
    end
  end

  # The world model only has to keep the generated corpus legal; the ground
  # truth is what the Writer stored, not this bookkeeping.
  defp apply_world(world, {:create, entity, row, group}) do
    %{
      world
      | entities:
          Map.put(world.entities, entity, %{
            groups: MapSet.new([group]),
            rows: %{row => group}
          }),
        rows: Map.put(world.rows, row, {entity, group})
    }
  end

  defp apply_world(world, {:add, entity, row, group}), do: add_row(world, entity, row, group)

  defp apply_world(world, {:move, entity, new_row, to, old_row}) do
    {^entity, from} = Map.fetch!(world.rows, old_row)
    world |> delete_row(old_row, entity, from) |> add_row(entity, new_row, to)
  end

  defp apply_world(world, {:remove, _entity, row, _group}) do
    {entity, from} = Map.fetch!(world.rows, row)
    delete_row(world, row, entity, from)
  end

  defp apply_world(world, {:update, _entity, _row, _group}), do: world

  defp add_row(world, entity, row, group) do
    entities =
      Map.update!(world.entities, entity, fn e ->
        %{e | groups: MapSet.put(e.groups, group), rows: Map.put(e.rows, row, group)}
      end)

    %{world | entities: entities, rows: Map.put(world.rows, row, {entity, group})}
  end

  defp delete_row(world, row, entity_id, group) do
    entities =
      Map.update(world.entities, entity_id, %{groups: MapSet.new(), rows: %{}}, fn e ->
        %{e | groups: MapSet.delete(e.groups, group), rows: Map.delete(e.rows, row)}
      end)

    %{world | entities: entities, rows: Map.delete(world.rows, row)}
  end

  defp touches?(updates, entity) do
    Enum.any?(updates, fn u ->
      u["subject_id"] == entity or Map.get(u, "data", %{}) |> leaf_entity() == entity
    end)
  end

  defp leaf_entity(%{"value" => value}), do: value
  defp leaf_entity(_), do: nil

  # -- comparison -----------------------------------------------------------

  defp compare(step, op, updates, gsn, stored_scopes, state) do
    {set_equal?, order_equal?} =
      Enum.zip(updates, stored_scopes)
      |> Enum.reduce({true, true}, fn {update, expected}, {set_ok, order_ok} ->
        got = MembershipIndex.scope(state, update, gsn)

        {set_ok and Enum.sort(got) == Enum.sort(expected), order_ok and got == expected}
      end)

    match =
      cond do
        set_equal? and order_equal? -> :same
        set_equal? -> :order_only
        true -> :different
      end

    %{
      step: step,
      op: op,
      gsn: gsn,
      match: match,
      stored: stored_scopes,
      resolved: resolve(state, updates, gsn)
    }
  end

  defp resolve(state, updates, gsn),
    do: Enum.map(updates, &MembershipIndex.scope(state, &1, gsn))

  defp stored_scopes(gsn) do
    key = RocksDB.encode_gsn_key(gsn)

    case RocksDB.get(RocksDB.cf_actions(), key) do
      {:ok, value} -> ActionFormat.decode(value, gsn)["update_scopes"]
      other -> raise "could not read cf_actions at #{gsn}: #{inspect(other)}"
    end
  end

  # -- rate -----------------------------------------------------------------

  defp rate(state, world) do
    entities = Map.keys(world.entities)

    probes =
      for _ <- 1..@rate_samples do
        entity = Enum.random(entities)
        as_of = :rand.uniform(10_000) + 1
        {entity, as_of}
      end

    index_us = time(fn -> Enum.each(probes, &resolve_probe(state, &1)) end) / @rate_samples
    current_us = time(fn -> Enum.each(probes, &current_probe/1) end) / @rate_samples

    pool_us = pool(probes)
    %{index_us_per_call: index_us, current_us_per_call: current_us, pool_us_per_call: pool_us}
  end

  defp resolve_probe(state, {entity, as_of}) do
    MembershipIndex.scope(
      state,
      %{"component" => "todo/title", "subject_id" => entity, "method" => "replace"},
      as_of
    )
  end

  defp current_probe({entity, as_of}) do
    _ = as_of
    EntityIndex.resolve_groups("todo", entity, cache_opts())
  end

  defp pool(probes) do
    chunks = Enum.chunk_every(probes, div(length(probes), @rate_workers))
    parent = self()

    started = System.monotonic_time(:microsecond)

    for chunk <- chunks do
      spawn(fn ->
        Enum.each(chunk, &current_probe/1)
        send(parent, :done)
      end)
    end

    for _ <- chunks, do: receive(do: (:done -> :ok))

    (System.monotonic_time(:microsecond) - started)
    |> then(fn us -> us / length(probes) end)
  end

  defp cache_opts do
    [
      entity_groups: CacheTables.entity_groups(),
      entity_groups_by_id: CacheTables.entity_groups_by_id(),
      entity_types: CacheTables.entity_types(),
      relationships_by_id: CacheTables.relationships_by_id(),
      group_members_by_id: CacheTables.group_members_by_id()
    ]
  end

  defp time(fun) do
    started = System.monotonic_time(:microsecond)
    fun.()
    System.monotonic_time(:microsecond) - started
  end

  defp prune_check(state) do
    max_gsn =
      state.versions
      |> Map.values()
      |> Enum.flat_map(fn list -> Enum.map(list, &elem(&1, 0)) end)
      |> Enum.max(fn -> 0 end)

    horizon = div(max_gsn, 2)
    {pruned, dropped} = MembershipIndex.prune(state, horizon)
    %{horizon: horizon, dropped: dropped, remaining: MembershipIndex.stats(pruned)}
  end

  # -- fixtures -------------------------------------------------------------

  defp second_group_action(ctx) do
    hlc = hlc()

    %{
      "id" => "act_diff_second_group",
      "actor_id" => ctx.actor_id,
      "hlc" => hlc,
      "updates" => [
        component("u_g2_name", @group2, "group/name", "replace", "Second"),
        component(
          "u_g2_actor",
          "gm_second",
          "groupMember/actor_id",
          "replace",
          Workbook.actor_id()
        ),
        component("u_g2_group", "gm_second", "groupMember/group_id", "replace", @group2),
        component("u_g2_perms", "gm_second", "groupMember/permissions", "replace", %{
          "todo" => ["create", "read", "update", "delete"]
        })
      ]
    }
  end

  defp write!(action) do
    validated = ActionValidator.to_validated_action(action)

    case Writer.write_actions([validated]) do
      {:ok, _range, []} -> :ok
      other -> raise "fixture write failed: #{inspect(other)}"
    end
  end

  defp todo(entity, field, value),
    do:
      component(
        "u_#{:erlang.unique_integer([:positive])}",
        entity,
        "todo/#{field}",
        "replace",
        value
      )

  defp membership_field(row, field, value) do
    %{
      "id" => "u_#{:erlang.unique_integer([:positive])}",
      "subject_id" => row,
      "component" => "entityGroup/#{field}",
      "method" => "replace",
      "data" => leaf(value)
    }
  end

  defp component(id, subject, component, method, value) do
    %{
      "id" => id,
      "subject_id" => subject,
      "component" => component,
      "method" => method,
      "data" => leaf(value)
    }
  end

  defp leaf(value), do: %{"value" => value, "hlc" => hlc()}
  defp hlc, do: System.os_time(:millisecond) * 65_536

  # -- output ---------------------------------------------------------------

  defp print(report) do
    IO.puts("""
    H2 corpus: #{report.committed} committed Actions, #{report.steps} planned
      matches: #{inspect(report.match_counts)}
      index: #{report.index.keys} rows / #{report.index.versions} versions
      resolution per call: index=#{Float.round(report.rate.index_us_per_call, 3)} us \
    current=#{Float.round(report.rate.current_us_per_call, 3)} us \
    pool4=#{Float.round(report.rate.pool_us_per_call, 3)} us
      prune at horizon #{report.prune.horizon}: dropped #{report.prune.dropped} versions, kept #{report.prune.remaining.versions}
    """)

    report.mismatches
    |> Enum.take(5)
    |> Enum.each(fn m ->
      IO.puts("  MISMATCH step=#{m.step} op=#{inspect(m.op)} gsn=#{m.gsn}")
      IO.puts("    stored:   #{inspect(m.stored)}")
      IO.puts("    resolved: #{inspect(m.resolved)}")
    end)
  end
end
