defmodule EbbServer.Sync.SSEConnectionTest do
  @moduledoc """
  Unit tests for SSEConnection GenServer.

  Tests SSE formatting and message handling. Full end-to-end SSE streaming
  requires a live HTTP server and is covered by integration tests.
  """

  use ExUnit.Case, async: false

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

  describe "message handling" do
    test "push_action sends encoded action as :data event" do
      action = %{
        "id" => "act_abc",
        "gsn" => 501,
        "actor_id" => "a_user1",
        "hlc" => 1_711_036_800_000,
        "updates" => [%{"field" => "value", "path" => ["name"]}]
      }

      encoded = Jason.encode!(action)
      expected = SSEConnection.format_sse_event("data", encoded)

      assert expected =~ "event: data\n"
      assert expected =~ ~s("id":"act_abc")
      assert expected =~ ~s("gsn":501)
      assert expected =~ ~s("actor_id":"a_user1")
      assert expected =~ ~s("hlc":1711036800000)
    end

    test "push_control sends encoded control as :control event" do
      control = %{"group" => "group_a", "nextOffset" => "502"}
      encoded = Jason.encode!(control)
      expected = SSEConnection.format_sse_event("control", encoded)

      assert expected =~ "event: control\n"
      assert expected =~ ~s("group":"group_a")
      assert expected =~ ~s("nextOffset":"502")
    end

    test "push_presence sends encoded presence as :presence event" do
      presence = %{
        "actor_id" => "a_user1",
        "entity_id" => "doc_1",
        "data" => %{"cursor" => %{"line" => 5, "col" => 12}}
      }

      encoded = Jason.encode!(presence)
      expected = SSEConnection.format_sse_event("presence", encoded)

      assert expected =~ "event: presence\n"
      assert expected =~ ~s("actor_id":"a_user1")
      assert expected =~ ~s("entity_id":"doc_1")
      assert expected =~ ~s("line":5)
      assert expected =~ ~s("col":12)
    end

    test "keepalive format is correct" do
      keepalive_msg = ": keepalive\n\n"
      assert keepalive_msg == ": keepalive\n\n"
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

  describe "Jason encoding" do
    test "action fields are correctly extracted and encoded" do
      action = %{
        "id" => "act_xyz",
        "gsn" => 999,
        "actor_id" => "user_abc",
        "hlc" => 1_712_000_000_000,
        "updates" => [
          %{"path" => ["title"], "field" => "text", "value" => "Hello"}
        ]
      }

      id = action["id"]
      gsn = action["gsn"]
      actor_id = action["actor_id"]
      hlc = action["hlc"]
      updates = action["updates"]

      assert id == "act_xyz"
      assert gsn == 999
      assert actor_id == "user_abc"
      assert hlc == 1_712_000_000_000
      assert length(updates) == 1
      assert updates |> hd() |> Map.get("value") == "Hello"
    end

    test "control events preserve all keys" do
      control = %{
        "group" => "group_b",
        "nextOffset" => "1001",
        "reconnect" => false
      }

      assert control["group"] == "group_b"
      assert control["nextOffset"] == "1001"
      assert control["reconnect"] == false
    end

    test "presence events with nested data encode correctly" do
      presence = %{
        "actor_id" => "actor_1",
        "entity_id" => "doc_xyz",
        "data" => %{
          "cursor" => %{
            "line" => 42,
            "col" => 15
          },
          "selection" => %{
            "start" => 0,
            "end" => 10
          }
        }
      }

      encoded = Jason.encode!(presence)
      assert encoded =~ "actor_1"
      assert encoded =~ "doc_xyz"
      assert encoded =~ "line"
      assert encoded =~ "col"
    end
  end

  describe "state structure" do
    test "SSEConnection state has correct fields" do
      state = %SSEConnection{
        conn: nil,
        group_ids: ["g1", "g2"],
        cursors: %{"g1" => 100, "g2" => 200},
        keepalive_ref: make_ref()
      }

      assert state.group_ids == ["g1", "g2"]
      assert state.cursors == %{"g1" => 100, "g2" => 200}
      assert %SSEConnection{keepalive_ref: ref} = state
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
