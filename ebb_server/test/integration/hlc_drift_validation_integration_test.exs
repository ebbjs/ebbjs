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

    test "HLC staleness rejected (>24h)" do
      hlc_stale = hlc_from(System.os_time(:millisecond) - 100_000_000)

      action = %{
        "id" => "act_stale_" <> Nanoid.generate(),
        "actor_id" => "a_test",
        "hlc" => hlc_stale,
        "updates" => [
          %{
            "id" => "upd_stale_" <> Nanoid.generate(),
            "subject_id" => "todo_stale",
            "subject_type" => "todo",
            "method" => "put",
            "data" => %{
              "fields" => %{
                "title" => %{"type" => "lww", "value" => "Stale Test", "hlc" => hlc_stale}
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
      assert rejection["reason"] == "hlc_stale"
    end
  end
end
