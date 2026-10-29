# What per-operation op submission costs, at the flush shapes the bench runs (#343).
#
# The write path submits a whole flush's ops to `:rocksdb` one `batch_put/4`
# call at a time. This script prices that leg in isolation, and prices a
# list-taking NIF (`batch_put_many/2`) against it when the loaded `rocksdb`
# build exports one:
#
#   per-op  `:rocksdb.batch()` + one `:rocksdb.batch_put/4` per op
#   bulk    `:rocksdb.batch()` + one `:rocksdb.batch_put_many/2` per op list
#   noop    the same crossing count using `:rocksdb.batch_count/1`, which
#           inspects no key or value, so it is the crossing floor
#   commit  `:rocksdb.write_batch/3` alone, `sync: false`
#
# The batch is built by the bench's own op-set builder and opened by the
# bench's own DB path, so it is the shape `t5` commits: 304 ops for a 100-Action
# `t0` flush and 1,195 for the 397-Action `t2` one.
#
# Each cell is the median of `rounds` rounds, and each round times
# `per_round` whole batches, so a single noisy iteration does not become the
# answer. Run it on a quiet host: these are isolated numbers, and the shipped
# pipeline pays more per op than this measures. The end-to-end effect is
# `mix bench.actions`, not this script.
#
# Run from `ebb_server/`:
#
#   MIX_ENV=dev mix run --no-start bench/batch_put_crossings.exs
#
# Recorded in `docs/research/343-bulk-batch-put.md`.

alias EbbServer.Bench.{Boot, Options, Workbook, WriteBatch}

shapes = [{"t0 (100 Actions)", 100}, {"t2 (397 Actions)", 397}]
rounds = 15
per_round = 100

bulk? = Code.ensure_loaded?(:rocksdb) and function_exported?(:rocksdb, :batch_put_many, 2)

IO.puts("list-taking bulk put in this build: #{if bulk?, do: "batch_put_many/2", else: "absent"}")

{:ok, base} =
  Options.parse([
    "--tier",
    "t5",
    "--duration",
    "1",
    "--warmup",
    "0",
    "--concurrency",
    "1",
    "--batch-size",
    "100",
    "--updates-per-action",
    "2",
    "--distribution",
    "hot",
    "--seed",
    "1",
    "--port",
    "4113"
  ])

boot = Boot.start(base)

ctx = %{
  group_id: Workbook.group_id(),
  actor_id: Workbook.actor_id(),
  entities: [],
  hot_entity_id: "todo_hot_343",
  hot_membership_id: "eg_hot_343",
  seeded_actions: 0
}

median = fn xs ->
  sorted = Enum.sort(xs)
  Enum.at(sorted, div(length(sorted), 2))
end

# Timed in microseconds; reported per batch and per op.
per_batch = fn round_us -> Float.round(round_us / per_round, 1) end
per_op = fn round_us, ops -> Float.round(round_us * 1000 / (per_round * ops), 1) end

# Times `per_round` whole batches built by `build`, once per round.
timed_rounds = fn ops_list, build ->
  for _ <- 1..rounds do
    started = System.monotonic_time(:microsecond)
    batches = Enum.map(ops_list, build)
    elapsed = System.monotonic_time(:microsecond) - started
    Enum.each(batches, &:rocksdb.release_batch/1)
    elapsed
  end
end

for {label, actions} <- shapes do
  config = %{base | batch_size: actions}

  # Disjoint GSN windows per batch, like a real flush; built outside the timer.
  ops_list =
    for i <- 1..per_round,
        do: WriteBatch.build_ops(config, ctx, 1, 1 + i * (actions + 100))

  ops_count = length(hd(ops_list))

  per_op_rounds =
    timed_rounds.(ops_list, fn ops ->
      {:ok, batch} = :rocksdb.batch()

      Enum.each(ops, fn {:put, cf, key, value} ->
        :ok = :rocksdb.batch_put(batch, cf, key, value)
      end)

      batch
    end)

  bulk_rounds =
    if bulk? do
      timed_rounds.(ops_list, fn ops ->
        {:ok, batch} = :rocksdb.batch()
        # `apply/3` keeps the script loadable on a build without the function,
        # which is what the `bulk?` guard is for.
        # credo:disable-for-next-line Credo.Check.Refactor.Apply
        :ok = apply(:rocksdb, :batch_put_many, [batch, ops])
        batch
      end)
    end

  noop_rounds =
    for _ <- 1..rounds do
      {:ok, batch} = :rocksdb.batch()
      started = System.monotonic_time(:microsecond)

      Enum.each(1..per_round, fn _ ->
        Enum.each(1..ops_count, fn _ -> :rocksdb.batch_count(batch) end)
      end)

      elapsed = System.monotonic_time(:microsecond) - started
      :ok = :rocksdb.release_batch(batch)
      elapsed
    end

  commit_rounds =
    for _ <- 1..rounds do
      batches = Enum.map(ops_list, &WriteBatch.batch/1)
      started = System.monotonic_time(:microsecond)
      Enum.each(batches, fn batch -> {:ok, _} = WriteBatch.commit(batch, false) end)
      System.monotonic_time(:microsecond) - started
    end

  IO.puts(
    "\n== #{label}: #{ops_count} ops per batch, " <>
      "#{rounds} rounds × #{per_round} batches =="
  )

  IO.puts(
    "  per-op  #{per_batch.(median.(per_op_rounds))} µs/batch  " <>
      "(#{per_op.(median.(per_op_rounds), ops_count)} ns/op)"
  )

  IO.puts(
    "  noop    #{per_batch.(median.(noop_rounds))} µs/batch  " <>
      "(#{per_op.(median.(noop_rounds), ops_count)} ns/op)"
  )

  if bulk? do
    saved = Enum.zip(per_op_rounds, bulk_rounds) |> Enum.map(fn {a, b} -> a - b end)

    IO.puts(
      "  bulk    #{per_batch.(median.(bulk_rounds))} µs/batch  " <>
        "(#{per_op.(median.(bulk_rounds), ops_count)} ns/op)"
    )

    IO.puts(
      "  saved   #{per_batch.(median.(saved))} µs/batch  " <>
        "(#{per_op.(median.(saved), ops_count)} ns/op)"
    )
  end

  IO.puts("  commit  #{per_batch.(median.(commit_rounds))} µs/batch")
end

Boot.stop(boot)
