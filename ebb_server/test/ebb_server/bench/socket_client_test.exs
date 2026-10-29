defmodule EbbServer.Bench.SocketClientTest do
  @moduledoc """
  Pins the wire parsing the real-socket client does on its hot path: the HTTP
  response head, chunked transfer encoding across read boundaries, SSE events
  split across chunk boundaries, and the GSN continuity check that the
  guardrail gate rests on.
  """

  use ExUnit.Case, async: true

  alias EbbServer.Bench.SocketClient

  @head "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\n" <>
          "cache-control: no-cache\r\ntransfer-encoding: chunked\r\n\r\n"

  @action ~s(event: data\ndata: {"actor_id":"a_bench","gsn":42,"hlc":7,"id":"a1","updates":[]}\n\n)

  defp chunk(payload),
    do: Integer.to_string(byte_size(payload), 16) <> "\r\n" <> payload <> "\r\n"

  describe "parse_response_head/1" do
    test "returns the status and headers once the head is complete" do
      assert {:ok, 200, headers, ""} = SocketClient.parse_response_head(@head)
      assert headers["content-type"] == "text/event-stream"
      assert headers["transfer-encoding"] == "chunked"
      assert SocketClient.chunked?(headers)
    end

    test "keeps the first body byte in the remainder" do
      assert {:ok, 200, _headers, "3\r\n"} =
               SocketClient.parse_response_head(@head <> "3\r\n")
    end

    test "asks for more while the head is incomplete" do
      assert {:more, partial} = SocketClient.parse_response_head("HTTP/1.1 200 OK\r\n")
      assert partial == "HTTP/1.1 200 OK\r\n"
    end

    test "reports a non-200 status" do
      assert {:ok, 403, _headers, ""} =
               SocketClient.parse_response_head("HTTP/1.1 403 Forbidden\r\n\r\n")
    end

    test "rejects a head that never terminates" do
      assert {:error, :head_too_large} =
               SocketClient.parse_response_head(String.duplicate("x", 20_000))
    end

    test "a non-chunked response is not chunked" do
      {:ok, 200, headers, ""} =
        SocketClient.parse_response_head("HTTP/1.1 200 OK\r\ncontent-length: 5\r\n\r\n")

      refute SocketClient.chunked?(headers)
    end
  end

  describe "decode_chunked/1" do
    test "decodes every complete chunk and reports the remainder" do
      buffer = chunk(@action) <> chunk(@action) <> "5\r\nabc"

      assert {:ok, [first, second], "5\r\nabc", :more} = SocketClient.decode_chunked(buffer)
      assert first == @action
      assert second == @action
    end

    test "keeps a partial chunk untouched" do
      full = chunk(@action)

      for split <- 1..(byte_size(full) - 1) do
        {left, right} = String.split_at(full, split)

        case SocketClient.decode_chunked(left) do
          {:ok, [], ^left, :more} ->
            # The next read completes the chunk.
            assert {:ok, [payload], "", :more} = SocketClient.decode_chunked(left <> right)
            assert payload == @action

          {:ok, [payload], remaining, :more} ->
            assert payload == @action
            assert {:ok, [], "", :more} = SocketClient.decode_chunked(remaining <> right)
        end
      end
    end

    test "accepts chunk extensions" do
      assert {:ok, ["hi"], "", :more} = SocketClient.decode_chunked("2;ext=1\r\nhi\r\n")
    end

    test "reports the terminating chunk" do
      assert {:ok, ["hi"], "", :done} = SocketClient.decode_chunked(chunk("hi") <> "0\r\n\r\n")
    end

    test "rejects a bad chunk size" do
      assert {:error, {:bad_chunk_size, "zz"}} = SocketClient.decode_chunked("zz\r\n")
    end
  end

  describe "consume/2" do
    test "counts data frames and reads the GSN without decoding the payload" do
      {counts, leftover, conn} = SocketClient.consume(@action, SocketClient.new_conn())

      assert counts.data == 1
      assert counts.control == 0
      assert leftover == ""
      assert conn.last_gsn == 42
      assert SocketClient.frame_gsn(@action) == 42
    end

    test "keeps a partial frame for the next read" do
      {prefix, suffix} = String.split_at(@action, 30)

      {counts, leftover, _conn} = SocketClient.consume(prefix, SocketClient.new_conn())
      assert counts.data == 0
      assert leftover == prefix

      {counts, leftover, conn} = SocketClient.consume(leftover <> suffix, SocketClient.new_conn())
      assert counts.data == 1
      assert leftover == ""
      assert conn.last_gsn == 42
    end

    test "counts control events and ignores keepalive comments" do
      buffer = "event: control\ndata: {\"reconnect\":true}\n\n: keepalive\n\n" <> @action

      {counts, "", _conn} = SocketClient.consume(buffer, SocketClient.new_conn())
      assert counts.data == 1
      assert counts.control == 1
    end

    test "frame kinds" do
      assert SocketClient.frame_kind("event: data\ndata: {}") == :data
      assert SocketClient.frame_kind("event: control\ndata: {}") == :control
      assert SocketClient.frame_kind("event: presence\ndata: {}") == :control
      assert SocketClient.frame_kind(": keepalive") == :comment
      assert SocketClient.frame_kind("data: {}") == :data
    end
  end

  describe "ingest/2 across transport and frame boundaries" do
    test "reassembles one action frame split over three reads" do
      body = chunk(@action)
      {first, rest} = String.split_at(body, 3)
      {second, third} = String.split_at(rest, 9)

      {conn, count} =
        Enum.reduce([first, second, third], {%{SocketClient.new_conn() | chunk_buffer: ""}, 0}, fn
          part, {conn, count} ->
            assert {:ok, counts, _leftover, conn} = SocketClient.ingest(conn, part)
            assert counts.holes == 0
            {conn, count + counts.data}
        end)

      assert count == 1
      assert conn.last_gsn == 42
    end

    test "an empty data event stream ends the connection" do
      assert {:error, :stream_ended} = SocketClient.ingest(SocketClient.new_conn(), "0\r\n\r\n")
    end
  end

  describe "GSN continuity" do
    defp gsns(list) do
      Enum.reduce(list, SocketClient.new_conn(), &SocketClient.advance_gsn(&2, &1))
    end

    test "a contiguous stream has no holes" do
      assert %{holes: 0, last_gsn: 4} = gsns([1, 2, 3, 4])
    end

    test "a gap counts every missing GSN" do
      assert %{holes: 4, last_gsn: 8} = gsns([1, 2, 6, 8])
    end

    test "a repeated GSN is the same Action delivered again, not a hole" do
      assert %{holes: 0} = gsns([1, 2, 2, 3])
    end

    test "an out-of-order GSN counts as one discontinuity" do
      assert %{holes: 1} = gsns([1, 2, 3, 2])
    end

    test "the first GSN anchors the sequence" do
      assert %{holes: 0, last_gsn: 501} = gsns([500, 501])
    end

    test "consume accumulates holes across a chunk" do
      frames =
        Enum.map_join([1, 4, 5], fn gsn ->
          ~s(event: data\ndata: {"gsn":#{gsn}}\n\n)
        end)

      {counts, "", conn} = SocketClient.consume(frames, SocketClient.new_conn())
      assert counts.data == 3
      assert counts.holes == 2
      assert conn.last_gsn == 5
    end
  end

  describe "frame_sent_us/1" do
    test "reads the workbook's monotonic stamp" do
      frame =
        ~s(event: data\ndata: {"gsn":1,"updates":[{"data":{"fields":) <>
          ~s({"bench_sent_us":{"hlc":5,"type":"lww","value":123456}}}]}}\n\n)

      assert SocketClient.frame_sent_us(frame) == 123_456
    end

    test "keeps a negative monotonic stamp's sign" do
      # `erlang:monotonic_time/0` has an undefined per-VM epoch, so the server's
      # stamp can be negative on the child's terms.
      frame =
        ~s(event: data\ndata: {"gsn":1,"updates":[{"data":{"fields":) <>
          ~s({"bench_sent_us":{"hlc":5,"type":"lww","value":-576460750230959}}}]}}\n\n)

      assert SocketClient.frame_sent_us(frame) == -576_460_750_230_959
    end

    test "is nil when the Action carries no stamp" do
      assert SocketClient.frame_sent_us(@action) == nil
    end

    test "is nil for a frame that is not JSON at all" do
      assert SocketClient.frame_sent_us("event: control\ndata: {}\n") == nil
    end
  end

  describe "reservoir_add/2" do
    test "keeps at most the cap and counts everything it saw" do
      reservoir =
        Enum.reduce(1..1_000, SocketClient.new_reservoir(10), &SocketClient.reservoir_add(&2, &1))

      assert reservoir.count == 10
      assert reservoir.seen == 1_000
      assert length(reservoir.samples) == 10
      assert Enum.all?(reservoir.samples, &(&1 in 1..1_000))
    end
  end
end
