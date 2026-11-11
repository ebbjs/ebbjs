defmodule EbbServer.Bench.LogAppendTest do
  @moduledoc """
  Pins the D3 contender's record format and its verifier: the window holds
  exactly the bytes the production flush stores in `cf_actions`, the frame
  GSNs are contiguous from the caller's base, and a torn, corrupted or
  out-of-order segment is reported rather than read as valid.
  """

  use ExUnit.Case, async: true

  alias EbbServer.Bench.{LogAppend, Options, Workbook, WriteBatch}

  setup do
    ctx = %{
      group_id: Workbook.group_id(),
      actor_id: Workbook.actor_id(),
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
        "log_first",
        "--batch-size",
        "10",
        "--distribution",
        "hot"
      ])

    {:ok, config: config, ctx: ctx}
  end

  describe "window_record/4" do
    test "header count matches the frames and GSNs are contiguous", %{config: config, ctx: ctx} do
      record = LogAppend.window_record(config, ctx, 3, 0)

      <<"E844", 1, count::unsigned-32, len::unsigned-32, crc::unsigned-32,
        payload::binary-size(len)>> = record

      assert count == 10
      assert :erlang.crc32(payload) == crc
      assert byte_size(record) == LogAppend.window_header() + len

      gsns = frame_gsns(payload, [])
      assert gsns == Enum.to_list(WriteBatch.gsn_start(3, 0)..(WriteBatch.gsn_start(3, 0) + 9))
    end

    test "a frame is the exact cf_actions value the batch arm writes", %{
      config: config,
      ctx: ctx
    } do
      action =
        config
        |> Workbook.build_action(ctx, 1, 0)
        |> EbbServer.Storage.ActionValidator.to_validated_action()

      [{:put, _cf, _key, expected}] = WriteBatch.stored_frame(action, WriteBatch.gsn_start(1, 0))

      assert LogAppend.stored_value(action) == expected
    end
  end

  describe "verify/1" do
    setup %{config: config, ctx: ctx} do
      path =
        Path.join(System.tmp_dir!(), "log_append_test_#{System.unique_integer([:positive])}.seg")

      records = Enum.map(0..4, &LogAppend.window_record(config, ctx, 1, &1 * 10))
      File.write!(path, records)
      on_exit(fn -> File.rm(path) end)
      {:ok, path: path, records: records}
    end

    test "a clean segment reports every window and frame", %{path: path} do
      summary = LogAppend.verify(path)

      assert summary.windows == 5
      assert summary.frames == 50
      assert summary.errors == []
    end

    test "a torn tail is reported, not read as a valid record", %{path: path} do
      torn = File.read!(path)
      File.write!(path, binary_part(torn, 0, byte_size(torn) - 6))

      assert LogAppend.verify(path).errors != []
    end

    test "a flipped byte is a window CRC failure", %{path: path} do
      <<head::binary-size(20), byte, tail::binary>> = File.read!(path)

      File.write!(path, <<head::binary, Bitwise.bxor(byte, 0xFF), tail::binary>>)

      assert :window_crc in LogAppend.verify(path).errors
    end

    test "out-of-order GSNs are reported", %{path: path} do
      reversed =
        path
        |> File.read!()
        |> then(fn bytes -> split_windows(bytes, []) end)
        |> Enum.reverse()
        |> IO.iodata_to_binary()

      File.write!(path, reversed)

      assert Enum.any?(LogAppend.verify(path).errors, &match?({:gsn_not_monotonic, _, _}, &1))
    end
  end

  describe "perform/4" do
    test "appends one datasync'd window and verifies", %{config: config, ctx: ctx} do
      config = %{config | durability: :async}
      since = System.os_time(:second) - 2
      before = LogAppend.verify_all(since: since) |> Enum.map(& &1.path) |> MapSet.new()

      assert {:ok, latency, bytes} = LogAppend.perform(config, ctx, 7, 0)
      assert latency >= 0
      assert bytes == byte_size(LogAppend.window_record(config, ctx, 7, 0))

      assert {:ok, _latency, _bytes} = LogAppend.perform(config, ctx, 7, 10)

      [summary] =
        Enum.reject(LogAppend.verify_all(since: since), &MapSet.member?(before, &1.path))

      assert summary.errors == []
      assert summary.frames == 20
      File.rm(summary.path)
    end
  end

  defp frame_gsns(<<>>, acc), do: Enum.reverse(acc)

  defp frame_gsns(
         <<gsn::unsigned-64, len::unsigned-32, _crc::unsigned-32, _value::binary-size(len),
           rest::binary>>,
         acc
       ),
       do: frame_gsns(rest, [gsn | acc])

  defp split_windows(<<>>, acc), do: Enum.reverse(acc)

  defp split_windows(
         <<"E844", 1, count::unsigned-32, len::unsigned-32, crc::unsigned-32,
           payload::binary-size(len), rest::binary>>,
         acc
       ),
       do:
         split_windows(rest, [
           <<"E844", 1, count::unsigned-32, len::unsigned-32, crc::unsigned-32, payload::binary>>
           | acc
         ])
end
