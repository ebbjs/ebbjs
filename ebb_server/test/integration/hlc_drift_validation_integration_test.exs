defmodule EbbServer.HLCDriftValidationIntegrationTest do
  use ExUnit.Case, async: false
  use EbbServer.Integration.StorageCase

  import EbbServer.TestHelpers
  import EbbServer.Integration.ActionHelpers

  describe "HLC drift validation" do
    test "HLC future drift rejected (>120s)" do
      hlc_future = hlc_from(System.os_time(:millisecond) + 200_000)

      action = %{
        "id" => "act_future_" <> Nanoid.generate(),
        "actor_id" => "a_test",
        "hlc" => hlc_future,
        "updates" => [
          %{
            "id" => "upd_future_" <> Nanoid.generate(),
            "subject_id" => "todo_future",
            "subject_type" => "todo",
            "method" => "put",
            "data" => %{
              "fields" => %{
                "title" => %{"type" => "lww", "value" => "Future Test", "hlc" => hlc_future}
              }
            }
          }
        ]
      }

      conn = post_actions(msgpack_encode!(%{"actions" => [action]}))
      assert conn.status == 200

      {:ok, response} = Jason.decode(conn.resp_body)
      assert response["rejected"] != []

      rejection = hd(response["rejected"])
      assert rejection["reason"] == "hlc_future_drift"
    end
  end

  describe "field leaf HLC bounds" do
    setup do
      bootstrap_group("a_test", "g_leaf_hlc", ["todo.create", "todo.update", "todo.read"])
      :ok
    end

    test "a far-future leaf HLC is rejected and leaves the field alone" do
      entity_id = create_original()

      attack = patch_action(entity_id, "pwned", generate_hlc(), hlc_from(in_ms(1_000_000_000)))

      assert %{"rejected" => [%{"reason" => "invalid_field_hlc"}]} = submit([attack])
      assert title_of(entity_id) == "original"
    end

    test "a corrective patch takes effect after a far-future leaf is rejected" do
      entity_id = create_original()

      attack = patch_action(entity_id, "pwned", generate_hlc(), hlc_from(in_ms(1_000_000_000)))
      assert %{"rejected" => [_]} = submit([attack])

      corrective_hlc = generate_hlc()
      corrective = patch_action(entity_id, "corrected", corrective_hlc, corrective_hlc)

      assert %{"rejected" => []} = submit([corrective])
      assert title_of(entity_id) == "corrected"
    end

    test "a leaf older than the stored one is accepted but does not win" do
      entity_id = create_original()
      corrective_hlc = generate_hlc()

      corrective = patch_action(entity_id, "corrected", corrective_hlc, corrective_hlc)
      assert %{"rejected" => []} = submit([corrective])

      stale = patch_action(entity_id, "stale", generate_hlc(), hlc_from(in_ms(-60_000)))
      assert %{"rejected" => []} = submit([stale])
      assert title_of(entity_id) == "corrected"
    end

    defp create_original do
      entity_id = "todo_leaf_hlc_" <> Nanoid.generate()
      create_hlc = hlc_from(in_ms(-60_000))

      assert %{"rejected" => []} =
               submit([put_action(entity_id, "original", create_hlc, create_hlc)])

      assert title_of(entity_id) == "original"
      entity_id
    end
  end

  defp in_ms(offset), do: System.os_time(:millisecond) + offset

  defp submit(actions) do
    conn = post_actions(msgpack_encode!(%{"actions" => actions}))
    assert conn.status == 200
    Jason.decode!(conn.resp_body)
  end

  defp put_action(entity_id, value, action_hlc, leaf_hlc) do
    %{
      "id" => "act_put_" <> Nanoid.generate(),
      "actor_id" => "a_test",
      "hlc" => action_hlc,
      "updates" => [
        %{
          "id" => "upd_put_" <> Nanoid.generate(),
          "subject_id" => entity_id,
          "subject_type" => "todo",
          "method" => "put",
          "data" => %{
            "fields" => %{"title" => %{"type" => "lww", "value" => value, "hlc" => leaf_hlc}}
          }
        },
        entity_group_update(entity_id, "g_leaf_hlc", action_hlc)
      ]
    }
  end

  defp patch_action(entity_id, value, action_hlc, leaf_hlc) do
    %{
      "id" => "act_patch_" <> Nanoid.generate(),
      "actor_id" => "a_test",
      "hlc" => action_hlc,
      "updates" => [
        %{
          "id" => "upd_patch_" <> Nanoid.generate(),
          "subject_id" => entity_id,
          "subject_type" => "todo",
          "method" => "patch",
          "data" => %{
            "fields" => %{"title" => %{"type" => "lww", "value" => value, "hlc" => leaf_hlc}}
          }
        }
      ]
    }
  end

  defp title_of(entity_id) do
    entity_id
    |> get_entity()
    |> Map.fetch!(:resp_body)
    |> Jason.decode!()
    |> get_in(["data", "fields", "title", "value"])
  end
end
