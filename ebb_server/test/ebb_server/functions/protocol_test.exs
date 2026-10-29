defmodule EbbServer.Functions.ProtocolTest do
  use ExUnit.Case, async: true

  alias EbbServer.Functions.Protocol
  alias EbbServer.TestFunctions

  describe "encode_frame/1 and decode/1" do
    test "round-trips a frame" do
      frame = Protocol.call("1", "get", %{"id" => "e_doc"})

      assert {:ok, [^frame], ""} = frame |> Protocol.encode_frame() |> Protocol.decode()
    end

    test "prefixes the JSON payload with its byte length" do
      frame = Protocol.result({:ok, %{"ok" => true}})
      <<length::32, json::binary>> = Protocol.encode_frame(frame)

      assert length == byte_size(json)
      assert Jason.decode!(json) == frame
    end

    test "decodes several frames and returns the trailing partial bytes" do
      first = Protocol.ready(1, "0.0.0")
      second = Protocol.call("1", "get", %{"id" => "e_doc"})
      third = Protocol.result({:ok, nil})

      third_binary = Protocol.encode_frame(third)
      prefix_size = byte_size(third_binary) - 5
      <<third_prefix::binary-size(prefix_size), third_tail::binary>> = third_binary

      buffer = Protocol.encode_frame(first) <> Protocol.encode_frame(second) <> third_prefix

      assert {:ok, [^first, ^second], ^third_prefix} = Protocol.decode(buffer)
      assert {:ok, [^third], ""} = Protocol.decode(third_prefix <> third_tail)
    end

    test "a frame split across three chunks decodes after the last chunk" do
      frame = Protocol.invoke(%{"name" => "proofreadDocument", "subject_actor_id" => "a_test"})
      binary = Protocol.encode_frame(frame)

      <<a::binary-size(1), b::binary-size(7), c::binary>> = binary

      assert {:ok, [], rest_a} = Protocol.decode(a)
      assert {:ok, [], rest_b} = Protocol.decode(rest_a <> b)
      assert {:ok, [^frame], ""} = Protocol.decode(rest_b <> c)
    end

    test "an incomplete header is buffered" do
      assert {:ok, [], <<0, 0>>} = Protocol.decode(<<0, 0>>)
    end

    test "refuses an oversize frame from its length prefix alone" do
      oversize = Protocol.max_frame_bytes() + 1

      assert {:error, {:frame_too_large, ^oversize}} = Protocol.decode(<<oversize::32>>)
    end

    test "refuses an empty frame" do
      assert {:error, :empty_frame} = Protocol.decode(<<0::32>>)
    end

    test "refuses invalid JSON" do
      assert {:error, {:invalid_json, _reason}} = Protocol.decode(<<3::32, "no!">>)
    end

    test "refuses JSON that is not a typed frame" do
      assert {:error, {:invalid_frame, []}} = Protocol.decode(<<2::32, "[]">>)
      assert {:error, {:invalid_frame, %{}}} = Protocol.decode(<<2::32, "{}">>)

      assert {:error, {:invalid_frame, %{"type" => 1}}} =
               Protocol.decode(<<10::32, ~s({"type":1})>>)
    end
  end

  describe "constructors" do
    test "builds the host-to-worker frames" do
      assert Protocol.invoke(name: "proofreadDocument", subject_actor_id: "a_test") == %{
               "type" => "invoke",
               "name" => "proofreadDocument",
               "subject_actor_id" => "a_test"
             }

      assert Protocol.reply("1", {:ok, %{"id" => "e_doc"}}) == %{
               "type" => "reply",
               "call_id" => "1",
               "ok" => true,
               "value" => %{"id" => "e_doc"}
             }

      assert Protocol.reply("2", {:error, %{"error" => "rejected"}}) == %{
               "type" => "reply",
               "call_id" => "2",
               "ok" => false,
               "error" => %{"error" => "rejected"}
             }
    end

    test "builds the worker-to-host frames" do
      assert Protocol.ready(4242, "0.0.0") == %{
               "type" => "ready",
               "pid" => 4242,
               "runner_version" => "0.0.0",
               "protocol_version" => 1
             }

      assert Protocol.call("1", "get", %{"id" => "e_doc"}) == %{
               "type" => "call",
               "call_id" => "1",
               "op" => "get",
               "payload" => %{"id" => "e_doc"}
             }

      assert Protocol.result({:ok, %{"ok" => true}}) == %{
               "type" => "result",
               "ok" => true,
               "value" => %{"ok" => true}
             }

      assert Protocol.result({:error, "handler_error", "boom"}) == %{
               "type" => "result",
               "ok" => false,
               "kind" => "handler_error",
               "message" => "boom"
             }
    end

    test "reports the protocol version and rejects any other" do
      assert Protocol.protocol_version() == 1
      assert Protocol.compatible_version?(1)
      refute Protocol.compatible_version?(2)
      refute Protocol.compatible_version?(nil)
    end
  end

  describe "checked-in fixtures" do
    test "every fixture is well-formed and every frame round-trips" do
      assert TestFunctions.fixture_names() != []

      Enum.each(TestFunctions.fixture_names(), fn name ->
        fixture = TestFunctions.load_fixture!(name)

        assert is_binary(fixture["name"])
        assert is_binary(fixture["description"])
        assert fixture["name"] == name
        assert [%{"send" => %{"type" => "ready"}} | _rest] = fixture["steps"]

        Enum.each(fixture["steps"], fn step ->
          assert exactly_one_step(step)
          Enum.each(frames_in(step), &assert_round_trip/1)
        end)
      end)
    end

    test "the canonical ready frame matches the constructor" do
      fixture = TestFunctions.load_fixture!("get-then-commit")
      %{"send" => ready} = hd(fixture["steps"])

      assert Protocol.ready(ready["pid"], ready["runner_version"], ready["protocol_version"]) ==
               ready
    end
  end

  defp exactly_one_step(step) do
    step
    |> Map.take(["send", "expect", "exit", "script"])
    |> map_size()
    |> Kernel.==(1)
  end

  defp frames_in(step) do
    case Map.take(step, ["send", "expect"]) do
      %{"send" => frame} -> [frame]
      %{"expect" => frame} -> [frame]
      _ -> []
    end
  end

  defp assert_round_trip(frame) do
    assert {:ok, [^frame], ""} = frame |> Protocol.encode_frame() |> Protocol.decode()
  end
end
