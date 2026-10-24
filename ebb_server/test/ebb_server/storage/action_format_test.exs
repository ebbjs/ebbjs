defmodule EbbServer.Storage.ActionFormatTest do
  @moduledoc """
  Pins the one shape of the stored `cf_actions` value.

  A stored Action is a frame — a 32-bit payload length, the GSN-free and
  scopes-free payload ETF, then the scopes ETF — and both readers
  (`decode/2` for the full Action, `decode_payload/2` for Updates only) read
  exactly that. Ebb is greenfield, so there is no second shape to keep
  reading and anything else must raise rather than decode as something
  plausible.
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
  defp scopes, do: [["g_1"], ["g_1", "g_2"]]

  defp expected_action(gsn) do
    %{
      "id" => "act_1",
      "actor_id" => "a_1",
      "hlc" => 123,
      "gsn" => gsn,
      "update_scopes" => scopes(),
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

  describe "frame/2" do
    test "lays out the payload length, the payload ETF, then the scopes ETF" do
      payload = payload_etf()
      size = byte_size(payload)
      value = ActionFormat.frame(payload, scopes())

      assert <<^size::32, ^payload::binary, scopes_etf::binary>> = value
      assert :erlang.binary_to_term(scopes_etf) == scopes()
    end

    test "refuses a payload that is not ETF" do
      assert_raise ArgumentError, ~r/holds an ETF payload/, fn ->
        ActionFormat.frame("not an ETF", [[]])
      end
    end

    test "refuses scopes that are not a list of group lists" do
      assert_raise ArgumentError, ~r/one group list per Update/, fn ->
        ActionFormat.frame(payload_etf(), "g_1")
      end
    end
  end

  describe "decode/2" do
    test "reads the payload and the scopes, taking the gsn from the key" do
      value = ActionFormat.frame(payload_etf(), scopes())

      assert ActionFormat.decode(value, 42) == expected_action(42)
    end
  end

  describe "decode_payload/2" do
    test "reads the payload without decoding the scopes" do
      value = ActionFormat.frame(payload_etf(), scopes())

      assert ActionFormat.decode_payload(value, 42) ==
               Map.delete(expected_action(42), "update_scopes")
    end
  end

  describe "an unreadable value" do
    test "rejects a record in the shape the pre-#552 code stored" do
      # `{payload_etf, update_scopes}` was the old wrapper. There is nothing
      # to migrate: this build never wrote it, and no build reads it.
      old_shape = :erlang.term_to_binary({payload_etf(), scopes()})

      assert_raise ArgumentError, ~r/not a stored Action frame/, fn ->
        ActionFormat.decode(old_shape, 42)
      end
    end

    test "rejects a plain map" do
      assert_raise ArgumentError, ~r/not a stored Action frame/, fn ->
        ActionFormat.decode(:erlang.term_to_binary(%{"id" => "act_1"}), 42)
      end
    end

    test "rejects an empty value" do
      assert_raise ArgumentError, ~r/not a stored Action frame/, fn ->
        ActionFormat.decode(<<>>, 42)
      end
    end

    test "rejects a frame whose length runs past the value" do
      assert_raise ArgumentError, ~r/not a stored Action frame/, fn ->
        ActionFormat.decode(<<4::32, "abc">>, 42)
      end
    end

    test "rejects a payload that does not decode to an Action" do
      value = ActionFormat.frame(:erlang.term_to_binary([1, 2, 3]), [[]])

      assert_raise ArgumentError, ~r/does not hold an Action payload/, fn ->
        ActionFormat.decode_payload(value, 42)
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
