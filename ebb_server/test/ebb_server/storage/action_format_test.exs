defmodule EbbServer.Storage.ActionFormatTest do
  @moduledoc """
  Pins the read-through contract of the stored `cf_actions` value.

  New writes are a v1 frame: a version byte, the payload ETF's length, the
  GSN-free and scopes-free payload, then the scopes ETF. Two older shapes
  still exist on disk and no longer have a writer: the pre-#552 wrapper of
  `:erlang.term_to_binary({payload_etf, update_scopes})` and the legacy
  plain map carrying its own `"gsn"` and `"update_scopes"`.

  Every reader goes through `decode/2` (full Action) or `decode_payload/2`
  (Updates only), so both must accept all three shapes. `"gsn"` comes from
  the record when it carries one and from the `cf_actions` key otherwise.
  """

  use ExUnit.Case, async: true

  alias EbbServer.Storage.{ActionFormat, PreparedAction}

  defp prepared_action do
    updates = [
      %{
        id: "upd_1",
        subject_id: "todo_1",
        subject_type: "todo",
        method: :put,
        data: %{"fields" => %{}}
      },
      %{
        id: "upd_2",
        subject_id: "todo_2",
        subject_type: "todo",
        method: :delete,
        data: nil
      }
    ]

    action = %{id: "act_1", actor_id: "a_1", hlc: 123, updates: updates}

    %PreparedAction{
      id: action.id,
      actor_id: action.actor_id,
      hlc: action.hlc,
      updates: updates,
      update_scopes: [["g_1"], ["g_1", "g_2"]],
      payload_etf: action |> ActionFormat.build() |> ActionFormat.encode()
    }
  end

  defp payload_etf, do: prepared_action() |> ActionFormat.build() |> ActionFormat.encode()

  # The pre-#552 writer stored the payload and the scopes as one ETF tuple.
  # No production code builds this shape any more, so the fixture does.
  defp pre_552_wrapper(payload_etf, update_scopes) do
    :erlang.term_to_binary({payload_etf, update_scopes})
  end

  defp legacy_map(extra) do
    Map.merge(
      %{
        "id" => "act_legacy",
        "actor_id" => "a_1",
        "hlc" => 100,
        "updates" => [
          %{
            "id" => "upd_legacy",
            "subject_id" => "todo_1",
            "subject_type" => "todo",
            "method" => "put",
            "data" => %{"fields" => %{}}
          }
        ]
      },
      extra
    )
  end

  defp expected_action(gsn) do
    %{
      "id" => "act_1",
      "actor_id" => "a_1",
      "hlc" => 123,
      "gsn" => gsn,
      "update_scopes" => [["g_1"], ["g_1", "g_2"]],
      "updates" => [
        %{
          "id" => "upd_1",
          "subject_id" => "todo_1",
          "subject_type" => "todo",
          "method" => "put",
          "data" => %{"fields" => %{}}
        },
        %{
          "id" => "upd_2",
          "subject_id" => "todo_2",
          "subject_type" => "todo",
          "method" => "delete",
          "data" => nil
        }
      ]
    }
  end

  defp expected_legacy_action(gsn, update_scopes) do
    legacy_map(%{"gsn" => gsn, "update_scopes" => update_scopes})
  end

  describe "decode/2 a v1 frame" do
    test "reads the payload and the scopes, taking the gsn from the key" do
      value = ActionFormat.frame(payload_etf(), [["g_1"], ["g_1", "g_2"]])

      assert ActionFormat.decode(value, 42) == expected_action(42)
    end

    test "starts with the version byte" do
      assert <<1, _rest::binary>> = ActionFormat.frame(payload_etf(), [[]])
    end
  end

  describe "decode/2 the pre-#552 wrapper" do
    test "reads the payload and the wrapper's scopes, taking the gsn from the key" do
      value = pre_552_wrapper(payload_etf(), [["g_1"], ["g_1", "g_2"]])

      assert ActionFormat.decode(value, 42) == expected_action(42)
    end
  end

  describe "decode/2 a legacy map" do
    test "trusts its own gsn and scopes" do
      scopes = [["g_1"]]
      value = :erlang.term_to_binary(expected_legacy_action(7, scopes))

      assert ActionFormat.decode(value, 42) == expected_legacy_action(7, scopes)
    end

    test "injects the key gsn when it has none" do
      scopes = [["g_1"]]
      value = :erlang.term_to_binary(legacy_map(%{"update_scopes" => scopes}))

      assert ActionFormat.decode(value, 42) == expected_legacy_action(42, scopes)
    end
  end

  describe "decode/2 an unknown version" do
    test "raises rather than falling through to the ETF term" do
      assert_raise ArgumentError, ~r/unsupported format version 2/, fn ->
        ActionFormat.decode(<<2, 0, 0, 0, 0>>, 1)
      end
    end
  end

  describe "decode/2 a corrupt record" do
    test "reports a truncated v1 frame as truncated, not as version 1" do
      payload = payload_etf()
      size = byte_size(payload) + 1

      assert_raise ArgumentError, ~r/truncated v1 frame/, fn ->
        ActionFormat.decode(<<1, size::32, payload::binary>>, 1)
      end
    end

    test "rejects an empty value" do
      assert_raise ArgumentError, ~r/is empty/, fn -> ActionFormat.decode(<<>>, 1) end
    end

    test "rejects an ETF term that is neither a wrapper nor a map" do
      assert_raise ArgumentError, ~r/not an Action/, fn ->
        ActionFormat.decode(:erlang.term_to_binary({:not_an_action, 1, 2}), 1)
      end
    end

    test "frame/2 refuses a payload that is not ETF" do
      assert_raise ArgumentError, ~r/holds an ETF payload/, fn ->
        ActionFormat.frame("not an ETF", [[]])
      end
    end
  end

  describe "decode_payload/2" do
    test "reads a v1 frame's payload without its scopes" do
      value = ActionFormat.frame(payload_etf(), [["g_1"], ["g_1", "g_2"]])

      assert ActionFormat.decode_payload(value, 42) ==
               Map.drop(expected_action(42), ["update_scopes"])
    end

    test "reads the pre-#552 wrapper's payload without its scopes" do
      value = pre_552_wrapper(payload_etf(), [["g_1"], ["g_1", "g_2"]])

      assert ActionFormat.decode_payload(value, 42) ==
               Map.drop(expected_action(42), ["update_scopes"])
    end

    test "drops a legacy map's own update_scopes and keeps its gsn" do
      value = :erlang.term_to_binary(expected_legacy_action(7, [["g_1"]]))

      assert ActionFormat.decode_payload(value, 42) ==
               expected_legacy_action(7, [["g_1"]]) |> Map.delete("update_scopes")
    end

    test "raises on an unknown version" do
      assert_raise ArgumentError, ~r/unsupported format version 2/, fn ->
        ActionFormat.decode_payload(<<2, 0, 0, 0, 0>>, 1)
      end
    end
  end

  describe "build/1" do
    test "omits gsn and update_scopes and stringifies an atom method" do
      payload = ActionFormat.build(prepared_action())

      assert Map.keys(payload) |> Enum.sort() == ["actor_id", "hlc", "id", "updates"]
      refute Map.has_key?(payload, "gsn")
      refute Map.has_key?(payload, "update_scopes")
      assert Enum.map(payload["updates"], & &1["method"]) == ["put", "delete"]
    end
  end

  describe "round trip" do
    test "build |> encode |> frame |> decode reproduces the Action" do
      prepared = prepared_action()

      action =
        prepared
        |> ActionFormat.build()
        |> ActionFormat.encode()
        |> ActionFormat.frame(prepared.update_scopes)
        |> ActionFormat.decode(99)

      assert action == expected_action(99)
    end
  end
end
