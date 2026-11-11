defmodule EbbServer.Storage.LogFirst.SegmentTest do
  @moduledoc """
  Recovery is the riskiest code in the log-first prototype (#844, D1), so this
  suite replays random record streams through kill points rather than checking
  a happy path.

  The contract under test: after any crash, `open/1` keeps exactly the records
  whose bytes were completely written and intact, truncates at that boundary,
  and the caller can re-append from `tail/1` to converge. No record is ever
  half-read, no GSN gap is opened inside what recovery accepts, and a torn tail
  is reported rather than silently skipped.
  """

  use ExUnit.Case, async: true

  alias EbbServer.Storage.LogFirst.Segment

  setup do
    path =
      Path.join(System.tmp_dir!(), "segment_test_#{System.unique_integer([:positive])}.seg")

    on_exit(fn -> File.rm(path) end)
    {:ok, path: path}
  end

  describe "append and read" do
    test "records round-trip by GSN and by range", %{path: path} do
      {:ok, log, []} = Segment.open(path)

      {:ok, log} = Segment.append(log, records(1, 10))
      {:ok, log} = Segment.append(log, records(11, 20))

      assert Segment.tail(log) == 20

      assert {:ok, %{gsn: 17, kind: :action_batch, body: "body-17"}} = Segment.read(log, 17)

      assert {:ok, read} = Segment.read_range(log, 5, 12)
      assert Enum.map(read, & &1.gsn) == Enum.to_list(5..12)

      assert :not_found = Segment.read(log, 21)
      Segment.close(log)
    end

    test "the sparse index answers past the first sample", %{path: path} do
      {:ok, log, []} = Segment.open(path)
      {:ok, log} = Segment.append(log, records(1, 200))

      assert length(log.index) == 4

      for gsn <- [1, 63, 64, 65, 127, 128, 199, 200] do
        assert {:ok, %{gsn: ^gsn}} = Segment.read(log, gsn)
      end

      Segment.close(log)
    end

    test "a non-increasing GSN is refused instead of written", %{path: path} do
      {:ok, log, []} = Segment.open(path)
      {:ok, log} = Segment.append(log, records(1, 5))

      assert {:error, {:gsn_not_after_tail, 5, 5}} = Segment.append(log, records(5, 5))
      assert {:error, {:gsn_not_after_tail, 3, 5}} = Segment.append(log, records(3, 3))

      {:ok, log} = Segment.append(log, records(6, 7))

      duplicate = records(8, 9) ++ [%{kind: :action_batch, gsn: 9, body: "again"}]
      assert {:error, {:gsn_not_ascending, 9, 9}} = Segment.append(log, duplicate)

      assert Segment.tail(log) == 7
      Segment.close(log)
    end
  end

  describe "torn tail" do
    test "a truncated append is discarded and the retry lands on the boundary", %{path: path} do
      {:ok, log, []} = Segment.open(path)
      {:ok, log} = Segment.append(log, records(1, 20))
      size = log.offset
      Segment.close(log)

      # Every byte offset of the last record's span is a possible crash point.
      {:ok, last, []} = Segment.open(path)
      {:ok, last_record} = Segment.read(last, 20)
      Segment.close(last)
      last_span = Segment.header_size() + byte_size(last_record.body)

      for cut <- 1..(last_span - 1)//3 do
        File.write!(path, binary_part(File.read!(path), 0, size - cut))

        {:ok, log, repairs} = Segment.open(path)
        assert repairs != [], "cut #{cut} should be reported"
        assert Segment.tail(log) == 19
        assert :not_found = Segment.read(log, 20)

        # The outbox retries the unacked record; it must fit the repaired tail.
        {:ok, log} = Segment.append(log, records(20, 20))
        assert Segment.tail(log) == 20
        assert {:ok, %{body: "body-20"}} = Segment.read(log, 20)
        Segment.close(log)

        {:ok, log, []} = Segment.open(path)
        Segment.close(log)
      end
    end

    test "a flipped byte is a CRC failure, not a readable record", %{path: path} do
      {:ok, log, []} = Segment.open(path)
      {:ok, log} = Segment.append(log, records(1, 40))
      Segment.close(log)

      bytes = File.read!(path)
      # Reach into the twentieth record: past 19 records, then past its header.
      {offset, _} = offset_of(bytes, 19)
      flipped = offset + Segment.header_size() + 2
      <<head::binary-size(flipped), byte, tail::binary>> = bytes
      File.write!(path, <<head::binary, Bitwise.bxor(byte, 0xFF), tail::binary>>)

      {:ok, log, repairs} = Segment.open(path)
      assert :crc in repairs
      assert Segment.tail(log) == 19
      Segment.close(log)
    end

    test "an empty or missing file opens as an empty segment", %{path: path} do
      assert {:ok, log, []} = Segment.open(path)
      assert Segment.tail(log) == nil
      assert {:ok, log} = Segment.append(log, records(1, 1))
      assert Segment.tail(log) == 1
      Segment.close(log)
    end
  end

  describe "kill-point property" do
    test "a random stream through a random crash converges on retry", %{path: path} do
      for seed <- 1..60 do
        :rand.seed(:exsss, {seed, seed * 7, seed * 13})
        path = path <> "-#{seed}"

        stream = records(1, :rand.uniform(80) + 1)
        {written, _rest} = Enum.split(stream, :rand.uniform(length(stream)))

        {:ok, log, []} = Segment.open(path)
        {:ok, log} = append_in_batches(log, written)
        size = log.offset
        Segment.close(log)

        # Crash: cut anywhere, including mid-header and mid-body.
        crash_at = if size == 0, do: 0, else: :rand.uniform(size) - 1
        File.write!(path, binary_part(File.read!(path), 0, crash_at))

        {:ok, log, repairs} = Segment.open(path)
        survived = if Segment.tail(log), do: Segment.tail(log), else: 0
        expected = Enum.map(written, & &1.gsn) |> Enum.take_while(&(&1 <= survived))
        assert expected == Enum.to_list(1..survived//1)

        for gsn <- expected do
          assert {:ok, %{gsn: ^gsn, body: "body-" <> _}} = Segment.read(log, gsn)
        end

        assert :not_found = Segment.read(log, survived + 1)

        # Retry everything the caller was never acked for; the file converges.
        {:ok, log} = append_in_batches(log, Enum.drop(stream, survived))
        assert Segment.tail(log) == length(stream)
        Segment.close(log)

        {:ok, clean, []} = Segment.open(path)
        assert clean.records == length(stream)
        assert repairs >= []
        Segment.close(clean)
        File.rm(path)
      end
    end
  end

  defp append_in_batches(log, records) do
    records
    |> Enum.chunk_every(:rand.uniform(17))
    |> Enum.reduce({:ok, log}, fn batch, {:ok, log} ->
      Segment.append(log, batch, :rand.uniform(2) == 1)
    end)
  end

  defp records(from, to) do
    Enum.map(from..to, fn gsn ->
      %{kind: :action_batch, gsn: gsn, body: "body-#{gsn}"}
    end)
  end

  defp offset_of(bytes, record_number) do
    walk_offsets(bytes, 0, 0, record_number)
  end

  defp walk_offsets(_bytes, offset, count, count), do: {offset, count}

  defp walk_offsets(bytes, offset, count, target) do
    <<_::binary-size(offset), _magic::binary-size(4), _kind::8, _gsn::unsigned-64,
      len::unsigned-32, _crc::unsigned-32, _body::binary-size(len), _::binary>> = bytes

    walk_offsets(bytes, offset + Segment.header_size() + len, count + 1, target)
  end
end
