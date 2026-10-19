defmodule EbbServer.Storage.ActionFormatTest do
  @moduledoc """
  Pins the dual-shape contract of the stored `cf_actions` value.

  New writes wrap a GSN-free, scopes-free payload ETF with the Action's
  `update_scopes`; Actions committed before #532 are a plain map that may
  carry `"gsn"` and `"update_scopes"`. Every reader goes through
  `decode/2`, which trusts a decoded `"gsn"` and otherwise injects the one
  from the `cf_actions` key.
  """

  use ExUnit.Case, async: true

  alias EbbServer.Storage.{ActionFormat, PreparedAction}

  defp prepared_action do
    %PreparedAction{
      id: "act_1",
      actor_id: "a_1",
      hlc: 123,
      updates: [
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
      ],
      intra_action_context: %{},
      update_scopes: [["g_1"], ["g_1", "g_2"]]
    }
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

  describe "decode/2" do
    test "trusts a legacy map's own gsn" do
      value = :erlang.term_to_binary(legacy_map(%{"gsn" => 7, "update_scopes" => [["g_1"]]}))

      action = ActionFormat.decode(value, 42)

      assert action["gsn"] == 7
      assert action["update_scopes"] == [["g_1"]]
      assert action["id"] == "act_legacy"
    end

    test "injects the key gsn when a legacy map has none" do
      value = :erlang.term_to_binary(legacy_map(%{"update_scopes" => [["g_1"]]}))

      action = ActionFormat.decode(value, 42)

      assert action["gsn"] == 42
      assert action["update_scopes"] == [["g_1"]]
    end

    test "decodes the new wrapper with the key gsn and the wrapper's scopes" do
      payload = ActionFormat.encode(ActionFormat.build(prepared_action()))
      value = ActionFormat.wrap(payload, [["g_1"], ["g_1", "g_2"]])

      action = ActionFormat.decode(value, 42)

      assert action["gsn"] == 42
      assert action["update_scopes"] == [["g_1"], ["g_1", "g_2"]]
      assert action["id"] == "act_1"
      assert action["actor_id"] == "a_1"
      assert action["hlc"] == 123
      assert Enum.map(action["updates"], & &1["id"]) == ["upd_1", "upd_2"]
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
    test "build |> encode |> wrap |> decode reproduces the Action" do
      prepared = prepared_action()

      action =
        prepared
        |> ActionFormat.build()
        |> ActionFormat.encode()
        |> ActionFormat.wrap(prepared.update_scopes)
        |> ActionFormat.decode(99)

      assert action == %{
               "id" => "act_1",
               "actor_id" => "a_1",
               "hlc" => 123,
               "gsn" => 99,
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
  end
end
