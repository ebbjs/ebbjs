# Multi-group frame-encode cost for one released range (#658).
#
# The bench tiers deliver every Action to one group, so this script prices the
# per-(range, group) frame build in isolation: the canonical 100-Action /
# 2-Update shape from `EbbServer.Bench.Workbook.build_action/4`, fanned to G
# groups with the same Update subset per group (the shape whose cost used to be
# linear in G).
#
#   before = `SSEConnection.data_frame/1` per (Action, group) + flatten, the
#            pre-#658 `GroupServer` `group_encode` hop.
#   encode = the `data_frame/1` calls the shipped code makes, once per
#            (Action, distinct Update subset): 100 at any fan-out width.
#   after  = `FanOutRouter.Frames.build/1` (memoise + encode + per-group
#            assembly) plus the per-group flatten the `GroupServer` does now.
#
# Run from `ebb_server/`:
#
#   MIX_ENV=dev mix run --no-start bench/fanout_frames.exs

alias EbbServer.Bench.{Options, Workbook}
alias EbbServer.Sync.FanOutRouter.Frames
alias EbbServer.Sync.SSEConnection

{:ok, config} =
  Options.parse([
    "--tier",
    "t4",
    "--batch-size",
    "100",
    "--updates-per-action",
    "2",
    "--distribution",
    "hot",
    "--rate",
    "1000",
    "--subscribers",
    "1",
    "--duration",
    "1",
    "--warmup",
    "0"
  ])

ctx = %{
  group_id: "g_bench",
  actor_id: "a_bench",
  entities: [],
  hot_entity_id: "todo_bench_hot",
  hot_membership_id: "eg_bench_hot",
  seeded_actions: 2
}

actions =
  for seq <- 1..100 do
    Workbook.build_action(config, ctx, 1, seq) |> Map.put("gsn", seq)
  end

group_ids = fn g -> for i <- 1..g, do: "g_bench_#{i}" end

# Every Action's Updates scope to every recipient group, so each group's copy
# carries the whole Update set. That is the shape the old path re-encoded once
# per group and the memo collapses to one encode per Action.
memberships = fn g -> for action <- actions, group_id <- group_ids.(g), do: {group_id, action} end

before_for = fn g ->
  fn ->
    for _group_id <- group_ids.(g) do
      actions
      |> Enum.map(&SSEConnection.data_frame/1)
      |> IO.iodata_to_binary()
    end
  end
end

encode_for = fn _g ->
  fn -> Enum.map(actions, &SSEConnection.data_frame/1) end
end

after_for = fn shape ->
  fn ->
    shape
    |> Frames.build()
    |> Enum.each(fn {_group_id, frames} -> IO.iodata_to_binary(frames) end)
  end
end

measure = fn fun ->
  for _ <- 1..20, do: fun.()

  times =
    for _ <- 1..300 do
      {us, _} = :timer.tc(fun)
      us
    end

  sorted = Enum.sort(times)
  {Enum.at(sorted, div(length(sorted) - 1, 2)), round(Enum.sum(times) / length(sorted))}
end

# The single-group frame bytes are the regression guard: the after path must
# produce exactly the pre-change flatten for every Action.
expected = before_for.(1).()

actual =
  Frames.build(memberships.(1))
  |> Enum.map(fn {_group_id, frames} -> IO.iodata_to_binary(frames) end)

if actual != expected do
  raise "single-group frames differ from the pre-#658 bytes"
end

IO.puts("|    G | before p50 | before mean | encode p50 | after p50 | after mean |")
IO.puts("| ---: | ---------: | ----------: | ---------: | --------: | ---------: |")

for g <- [1, 2, 4] do
  shape = memberships.(g)
  {before_p50, before_mean} = measure.(before_for.(g))
  {encode_p50, _encode_mean} = measure.(encode_for.(g))
  {after_p50, after_mean} = measure.(after_for.(shape))

  IO.puts(
    "| #{g} | #{before_p50} | #{before_mean} | #{encode_p50} | #{after_p50} | #{after_mean} |"
  )
end
