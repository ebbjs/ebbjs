defmodule EbbServer.SSEHelpers do
  @moduledoc """
  Helpers for asserting on coalesced SSE byte streams.

  The fan-out path delivers one `{:sse_data, bytes}` message per subscriber
  per committed batch. `bytes` is the concatenation of one SSE event block
  per Action, so tests split it back into the individual `data:` payloads
  and assert on their content and order.
  """

  import ExUnit.Assertions

  @doc """
  Splits a coalesced SSE byte stream into the JSON payload of each `data:` event.

  Frames are separated by a blank line; one event block looks like
  `event: data\\ndata: <json>\\n\\n`.
  """
  @spec data_payloads(iodata()) :: [String.t()]
  def data_payloads(bytes) do
    bytes
    |> IO.iodata_to_binary()
    |> String.split("\n\n", trim: true)
    |> Enum.map(&data_line/1)
  end

  @doc """
  Asserts that `bytes` carries exactly the given `data:` payloads, in order.
  """
  @spec assert_data_payloads(iodata(), [String.t()]) :: true
  def assert_data_payloads(bytes, expected) do
    assert data_payloads(bytes) == expected
  end

  @doc """
  Returns the single `data:` payload of a byte stream, asserting there is exactly one.
  """
  @spec single_data_payload(iodata()) :: String.t()
  def single_data_payload(bytes) do
    assert [payload] = data_payloads(bytes)
    payload
  end

  @doc """
  Collects at least `count` data payloads across coalesced SSE chunks,
  preserving the order they reached the subscriber.
  """
  @spec receive_data_payloads(non_neg_integer(), [String.t()]) :: [String.t()]
  def receive_data_payloads(count, acc \\ []) do
    if length(acc) >= count do
      acc
    else
      assert_receive {:sse_data, bytes}, 5_000
      receive_data_payloads(count, acc ++ data_payloads(bytes))
    end
  end

  defp data_line(frame) do
    frame
    |> String.split("\n")
    |> Enum.find_value(fn
      "data: " <> payload -> payload
      _ -> nil
    end)
  end
end
