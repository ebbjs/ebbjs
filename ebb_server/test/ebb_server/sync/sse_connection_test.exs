defmodule EbbServer.Sync.SSEConnectionTest do
  @moduledoc """
  Unit tests for SSEConnection GenServer.

  Tests SSE formatting and message handling. Full end-to-end SSE streaming
  requires a live HTTP server and is covered by integration tests.
  """

  use ExUnit.Case, async: false

  import EbbServer.SSEHelpers
  import EbbServer.TestHelpers

  alias EbbServer.Sync.SSEConnection

  describe "format_sse_event/2" do
    test "formats action event correctly" do
      data = ~s({"id":"act_abc","gsn":501})
      result = SSEConnection.format_sse_event("data", data)

      assert result == "event: data\ndata: {\"id\":\"act_abc\",\"gsn\":501}\n\n"
    end

    test "formats control event correctly" do
      data = ~s({"group":"group_a","nextOffset":"502"})
      result = SSEConnection.format_sse_event("control", data)

      assert result == "event: control\ndata: {\"group\":\"group_a\",\"nextOffset\":\"502\"}\n\n"
    end

    test "formats presence event correctly" do
      data = ~s({"actor_id":"a_user1","entity_id":"doc_1"})
      result = SSEConnection.format_sse_event("presence", data)

      assert result ==
               "event: presence\ndata: {\"actor_id\":\"a_user1\",\"entity_id\":\"doc_1\"}\n\n"
    end

    test "event type and data are properly separated" do
      result = SSEConnection.format_sse_event("data", "{}")

      assert result =~ "event: data\n"
      assert result =~ "\ndata: "
      assert result =~ "\n\n"
    end
  end

  describe "data_frame/1" do
    test "renders the exact 5-key action map as one data event" do
      action = %{
        "id" => "act_abc",
        "gsn" => 501,
        "actor_id" => "a_user1",
        "hlc" => 1_711_036_800_000,
        "updates" => [%{"field" => "value"}],
        "extra" => "dropped from the wire"
      }

      assert SSEConnection.data_frame(action) ==
               "event: data\n" <>
                 "data: {\"actor_id\":\"a_user1\",\"gsn\":501,\"hlc\":1711036800000," <>
                 "\"id\":\"act_abc\",\"updates\":[{\"field\":\"value\"}]}\n\n"
    end

    test "drops keys outside the 5-key projection" do
      frame =
        SSEConnection.data_frame(%{
          "id" => "act_1",
          "gsn" => 1,
          "actor_id" => "a_user1",
          "hlc" => 7,
          "updates" => [],
          "secret" => "not on the wire"
        })

      refute frame =~ "secret"

      assert frame |> single_data_payload() |> Jason.decode!() |> Map.keys() |> Enum.sort() ==
               ["actor_id", "gsn", "hlc", "id", "updates"]
    end
  end

  describe "push_data/2" do
    test "forwards the raw bytes to the parent as {:sse_data, bytes}" do
      {:ok, pid} = SSEConnection.start_link(self(), ["g1"], %{"g1" => 0})

      bytes =
        SSEConnection.data_frame(%{
          "id" => "act_1",
          "gsn" => 1,
          "actor_id" => "a_user1",
          "hlc" => 7,
          "updates" => []
        })

      assert :ok = SSEConnection.push_data(pid, bytes)
      assert_receive {:sse_data, ^bytes}
    end

    test "push_data/3 forwards the sampled delivery with its meta and emits conn_deliver" do
      {:ok, pid} = SSEConnection.start_link(self(), ["g1"], %{"g1" => 0})
      ref = attach_telemetry([[:ebb, :fanout, :hop_ms]])
      cast_at = System.monotonic_time()

      bytes = "event: data\ndata: {}\n\n"
      meta = %{cast_at: cast_at, committed_at: cast_at, group_id: "g1"}

      assert :ok = SSEConnection.push_data(pid, bytes, meta)
      assert_receive {:sse_data, ^bytes, ^meta}

      assert [
               {[:ebb, :fanout, :hop_ms], %{duration: duration},
                %{hop: :conn_deliver, group_id: "g1"}}
             ] = telemetry_events(ref)

      assert is_integer(duration) and duration >= 0
    end

    test "push_data/2 emits no conn_deliver hop" do
      {:ok, pid} = SSEConnection.start_link(self(), ["g1"], %{"g1" => 0})
      ref = attach_telemetry([[:ebb, :fanout, :hop_ms]])

      assert :ok = SSEConnection.push_data(pid, "event: data\ndata: {}\n\n")
      assert_receive {:sse_data, _bytes}

      assert telemetry_events(ref) == []
    end

    test "shares one binary across a coalesced batch without re-encoding" do
      {:ok, pid} = SSEConnection.start_link(self(), ["g1"], %{"g1" => 0})

      batch =
        SSEConnection.data_frame(%{
          "id" => "act_1",
          "gsn" => 1,
          "actor_id" => "a_user1",
          "hlc" => 7,
          "updates" => []
        }) <>
          SSEConnection.data_frame(%{
            "id" => "act_2",
            "gsn" => 2,
            "actor_id" => "a_user2",
            "hlc" => 8,
            "updates" => []
          })

      assert :ok = SSEConnection.push_data(pid, batch)
      assert_receive {:sse_data, ^batch}
      assert data_payloads(batch) |> Enum.map(&Jason.decode!(&1)["id"]) == ["act_1", "act_2"]
    end
  end

  describe "message handling" do
    test "push_control forwards the encoded control payload as :sse_chunk" do
      {:ok, pid} = SSEConnection.start_link(self(), ["g1"], %{"g1" => 0})
      control = %{"group" => "group_a", "nextOffset" => "502"}

      assert :ok = SSEConnection.push_control(pid, control)
      assert_receive {:sse_chunk, "control", payload}
      assert Jason.decode!(payload) == control
    end

    test "push_presence forwards the encoded presence payload as :sse_chunk" do
      {:ok, pid} = SSEConnection.start_link(self(), ["g1"], %{"g1" => 0})

      presence = %{
        "actor_id" => "a_user1",
        "entity_id" => "doc_1",
        "data" => %{"cursor" => %{"line" => 5, "col" => 12}}
      }

      assert :ok = SSEConnection.push_presence(pid, presence)
      assert_receive {:sse_chunk, "presence", payload}
      assert Jason.decode!(payload) == presence
    end
  end

  describe "SSE event format" do
    test "events are separated by double newline" do
      event1 = SSEConnection.format_sse_event("data", "{}")
      event2 = SSEConnection.format_sse_event("control", "{}")

      combined = event1 <> event2
      assert combined =~ "\n\n"
      assert combined =~ "event: data"
      assert combined =~ "event: control"
    end

    test "each field line ends with single newline" do
      event = SSEConnection.format_sse_event("data", "{}")

      lines = String.split(event, "\n")
      assert Enum.count(lines) == 4
    end
  end

  describe "state structure" do
    test "SSEConnection state has correct fields" do
      state = %SSEConnection{
        parent_pid: self(),
        group_ids: ["g1", "g2"],
        cursors: %{"g1" => 100, "g2" => 200},
        parent_monitor: make_ref()
      }

      assert state.group_ids == ["g1", "g2"]
      assert state.cursors == %{"g1" => 100, "g2" => 200}
      assert %SSEConnection{parent_monitor: ref} = state
      assert is_reference(ref)
    end

    test "cursors map can track multiple groups" do
      cursors = %{"group_a" => 501, "group_b" => 1002, "group_c" => 50}

      assert Map.get(cursors, "group_a") == 501
      assert Map.get(cursors, "group_b") == 1002
      assert Map.get(cursors, "group_c") == 50
    end
  end
end
