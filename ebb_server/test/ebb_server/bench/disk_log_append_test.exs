defmodule EbbServer.Bench.DiskLogAppendTest do
  @moduledoc """
  Pins D3b's `disk_log` arm: it appends the same window records the owned
  segment does, `disk_log` adds no framing bytes of its own (an external halt
  log is a byte sink), and `repair: true` reports nothing about a torn tail —
  an external log has no framing for `disk_log` to repair, so recovery is the
  record format's job.
  """

  use ExUnit.Case, async: true

  alias EbbServer.Bench.{DiskLogAppend, LogAppend, Options}

  @caller 42
  @batch_size 10

  setup do
    ctx = %{
      group_id: "g_bench",
      actor_id: "a_bench",
      entities: Enum.map(1..10, &"todo_seed_#{&1}"),
      hot_entity_id: "todo_bench_hot",
      hot_membership_id: "eg_bench_hot",
      seeded_actions: 1
    }

    {:ok, config} =
      Options.parse([
        "--tier",
        "t5",
        "--engine",
        "disk_log",
        "--batch-size",
        "#{@batch_size}",
        "--distribution",
        "hot"
      ])

    {:ok, config: config, ctx: ctx}
  end

  describe "--engine disk_log" do
    test "is a t5-only append selector that prints in the reproduction command" do
      assert {:ok, config} = Options.parse(["--tier", "t5", "--engine", "disk_log"])
      assert config.engine == :disk_log
      assert Options.command(config) =~ "--engine disk_log"
      assert Options.engine_description(:disk_log) =~ "balog"

      assert {:error, message} = Options.parse(["--tier", "t0", "--engine", "disk_log"])
      assert message =~ "only supported with --tier t5"
    end
  end

  describe "perform/4" do
    test "writes exactly the window records, with no disk_log bytes around them", %{
      config: config,
      ctx: ctx
    } do
      {written, _synced_bytes} =
        Enum.map_reduce([0, 10, 20], 0, fn seq, so_far ->
          assert {:ok, _latency, bytes} = DiskLogAppend.perform(config, ctx, @caller, seq)
          assert bytes > LogAppend.window_header()

          # A halt log preallocates nothing, so the file holds exactly what
          # has been synced: no reservation, no padding, no record header.
          assert File.stat!(DiskLogAppend.current_path()).size == so_far + bytes
          {bytes, so_far + bytes}
        end)

      path = DiskLogAppend.current_path()
      assert :ok = DiskLogAppend.close()
      on_exit(fn -> File.rm(path) end)

      total = Enum.sum(written)
      assert File.stat!(path).size == total

      assert %{records: records, bytes: ^total, error: nil} = DiskLogAppend.recovery(path)

      assert Enum.map(records, & &1.count) == List.duplicate(@batch_size, 3)

      assert Enum.map(records, & &1.offset) ==
               [0] ++ Enum.scan(Enum.take(written, 2), &(&1 + &2))

      assert Enum.map(records, & &1.bytes) == written
    end

    test "--durability async appends without syncing, so the record lands on close", %{
      config: config,
      ctx: ctx
    } do
      config = %{config | durability: :async}

      assert {:ok, _latency, bytes} = DiskLogAppend.perform(config, ctx, @caller, 0)
      path = DiskLogAppend.current_path()
      assert :ok = DiskLogAppend.close()
      on_exit(fn -> File.rm(path) end)

      # `balog/2` hands the record to the disk_log process's write cache; the
      # async sample prices that enqueue only. Closing flushes it, so the
      # record is not lost — it was never synced.
      assert File.stat!(path).size == bytes
      assert %{records: [record], bytes: ^bytes, error: nil} = DiskLogAppend.recovery(path)
      assert record.count == @batch_size
    end
  end

  describe "recovery of a torn external log" do
    test "repair: true reports nothing, truncates nothing, and loses the tail after the tear", %{
      config: config,
      ctx: ctx
    } do
      written =
        for seq <- Enum.map(0..5, &(&1 * 10)) do
          assert {:ok, _latency, bytes} = DiskLogAppend.perform(config, ctx, @caller, seq)
          bytes
        end

      path = DiskLogAppend.current_path()
      assert :ok = DiskLogAppend.close()
      on_exit(fn -> File.rm(path) end)

      intact = written |> Enum.take(5) |> Enum.sum()
      torn = Enum.at(written, 5)
      content = File.read!(path)
      assert byte_size(content) == intact + torn

      # Cut the sixth record in the middle of its payload.
      cut = intact + div(torn, 2)
      File.write!(path, binary_part(content, 0, cut))

      name = :"ebb_spike_844_d3_repair_#{System.unique_integer([:positive])}"

      assert {:ok, log} =
               :disk_log.open(
                 name: name,
                 file: String.to_charlist(path),
                 type: :halt,
                 format: :external,
                 repair: true
               )

      # The answer to "what does repair: true return": {:ok, Log}. Nothing is
      # reported, nothing is truncated, and the file is not readable through
      # disk_log at all.
      assert File.stat!(path).size == cut
      assert :disk_log.chunk(log, :start, 100) == {:error, {:format_external, name}}

      # Only the record format can report the tear: five whole records, then
      # half of the sixth at the boundary.
      assert %{records: records, bytes: ^intact, error: {:torn_tail, ^intact, remaining}} =
               DiskLogAppend.recovery(path)

      assert remaining == div(torn, 2)
      assert Enum.map(records, & &1.count) == List.duplicate(@batch_size, 5)

      # Appending through the repaired log lands behind the tear, so the new
      # record is unreachable too: repair does not move the write position
      # back to the last intact boundary.
      :ok = :disk_log.balog(log, "appended-after-the-tear")
      :ok = :disk_log.sync(log)
      :ok = :disk_log.close(log)

      assert File.stat!(path).size == cut + byte_size("appended-after-the-tear")

      assert %{records: still_five, error: {:torn_tail, ^intact, _}} =
               DiskLogAppend.recovery(path)

      assert length(still_five) == 5
    end
  end

  describe "close/0" do
    test "is a no-op for a caller that never sampled" do
      assert :ok = DiskLogAppend.close()
    end
  end
end
