defmodule EbbServer.Functions.HostTest do
  use ExUnit.Case, async: false
  use EbbServer.Integration.StorageCase, with_auth_mode: true

  import EbbServer.Integration.ActionHelpers
  import EbbServer.TestHelpers
  import ExUnit.CaptureLog

  alias EbbServer.Functions.Host
  alias EbbServer.Storage.{ActionLog, RocksDB, WatermarkTracker}

  @invocation_id "inv_host_test"
  @context %{actor_id: "a_test", invocation_id: @invocation_id}
  # What `Host.commit/3` derives for `@invocation_id`: `"a_" <> first16(sha256)`.
  @action_id "a_" <>
               binary_part(
                 Base.encode16(:crypto.hash(:sha256, @invocation_id), case: :lower),
                 0,
                 16
               )

  def storage_writer_opts do
    [
      commit_fn: fn ops, opts ->
        if :persistent_term.get({__MODULE__, :fail_commits}, false) do
          {:error, :injected_commit_failure}
        else
          RocksDB.write_batch(ops, opts)
        end
      end
    ]
  end

  setup do
    bootstrap_group("a_test", "g_test", ["doc.create", "doc.update", "doc.read"])
    bootstrap_group("a_other", "g_other", ["doc.create", "doc.update", "doc.read"])

    write_entity_in_group("a_test", "e_doc", "doc", "g_test", fields("Original"))
    write_entity_in_group("a_other", "e_other", "doc", "g_other", fields("Other"))

    :persistent_term.put({__MODULE__, :fail_commits}, false)
    on_exit(fn -> :persistent_term.erase({__MODULE__, :fail_commits}) end)

    :ok
  end

  describe "get" do
    test "returns the same view the HTTP read endpoint serves" do
      assert {:ok, view} = Host.get(%{"id" => "e_doc"}, @context)

      assert view["id"] == "e_doc"
      assert view["type"] == "doc"
      assert view["data"]["fields"]["title"]["value"] == "Original"
    end

    test "a missing entity is null" do
      assert {:ok, nil} = Host.get(%{"id" => "e_missing"}, @context)
    end

    test "an entity the actor cannot read is null, not an error" do
      assert {:ok, nil} = Host.get(%{"id" => "e_other"}, @context)

      assert {:ok, view} = Host.get(%{"id" => "e_other"}, %{actor_id: "a_other"})
      assert view["id"] == "e_other"
    end

    test "a payload without an id is a protocol error" do
      assert {:error, %{"error" => "protocol_error", "status" => 500}} =
               Host.get(%{}, @context)

      assert {:error, %{"error" => "protocol_error"}} = Host.get(nil, @context)
    end
  end

  describe "commit" do
    test "submits one Action as the invocation actor, ignoring the frame's id and actor_id" do
      before = WatermarkTracker.committed_watermark()
      action = action("e_doc", "Revised", "a_impostor")

      refute action["id"] == @action_id

      assert {:ok, %{"replayed" => false}} = Host.commit(action, @context)
      assert WatermarkTracker.committed_watermark() == before + 1

      assert [stored] = ActionLog.read(before + 1, before + 1)
      assert stored["id"] == @action_id
      assert stored["actor_id"] == "a_test"

      assert {:ok, view} = Host.get(%{"id" => "e_doc"}, @context)
      assert view["data"]["fields"]["title"]["value"] == "Revised"
    end

    test "a second commit under the same invocation id replays and drops its writes" do
      before = WatermarkTracker.committed_watermark()

      assert {:ok, %{"replayed" => false}} =
               Host.commit(action("e_doc", "First", "a_test"), @context)

      assert {:ok, %{"replayed" => true}} =
               Host.commit(action("e_doc", "Second", "a_test"), @context)

      # One invocation commits at most one Action: the second commit carries the
      # first one's id, so the dedup index answers it without a GSN.
      assert WatermarkTracker.committed_watermark() == before + 1
      assert [stored] = ActionLog.read(before + 1, before + 1)
      assert stored["id"] == @action_id

      assert {:ok, view} = Host.get(%{"id" => "e_doc"}, @context)
      assert view["data"]["fields"]["title"]["value"] == "First"
    end

    test "a rejection is 422 with the sync/actions rejection list and writes nothing" do
      before = WatermarkTracker.committed_watermark()
      action = action("e_other", "Rejected", "a_test")

      assert {:error, %{"error" => "rejected", "status" => 422, "details" => details} = error} =
               Host.commit(action, @context)

      assert details =~ "not_authorized"

      # The same `%{"id", "reason", "details"?}` maps `POST /sync/actions`
      # returns, because both run `ActionSubmission.submit/3`.
      assert [%{"id" => @action_id, "reason" => "not_authorized"} = rejection] =
               error["rejected"]

      assert Map.keys(rejection) -- ["details", "id", "reason"] == []

      assert WatermarkTracker.committed_watermark() == before
      assert ActionLog.read(before + 1, before + 10) == []
    end

    test "a Writer failure is 500 and says the outcome is unknown" do
      :persistent_term.put({__MODULE__, :fail_commits}, true)
      action = action("e_doc", "Unknown", "a_test")

      capture_log(fn ->
        assert {:error,
                %{
                  "error" => "write_failed",
                  "status" => 500,
                  "details" => "the write outcome is unknown"
                }} = Host.commit(action, @context)
      end)
    end

    test "a payload that is not an Action is a protocol error" do
      assert {:error, %{"error" => "protocol_error", "status" => 500}} =
               Host.commit(["not", "an", "action"], @context)
    end

    test "a context without an invocation id is a protocol error, not a crash" do
      assert {:error, %{"error" => "protocol_error", "status" => 500, "details" => details}} =
               Host.commit(action("e_doc", "NoContext", "a_test"), %{actor_id: "a_test"})

      assert details =~ "invocation_id"
    end
  end

  describe "dispatch/4" do
    test "routes the v1 ops" do
      assert {:ok, %{"id" => "e_doc"}} = Host.dispatch("get", %{"id" => "e_doc"}, @context)

      assert {:ok, %{"replayed" => false}} =
               Host.dispatch("commit", action("e_doc", "Dispatched", "a_test"), @context)
    end

    test "an unlisted op is a protocol error rather than a silent null" do
      assert {:error, %{"error" => "protocol_error", "status" => 500, "details" => details}} =
               Host.dispatch("query", %{}, @context)

      assert details =~ "query"
    end
  end

  defp fields(value) do
    hlc = generate_hlc()
    %{"title" => %{"type" => "lww", "value" => value, "hlc" => hlc}}
  end

  defp action(entity_id, value, actor_id) do
    hlc = generate_hlc()

    %{
      "id" => "act_host_#{System.unique_integer([:positive])}",
      "actor_id" => actor_id,
      "hlc" => hlc,
      "updates" => [
        %{
          "id" => "upd_host_#{System.unique_integer([:positive])}",
          "subject_id" => entity_id,
          "subject_type" => "doc",
          "method" => "patch",
          "data" => %{
            "fields" => %{"title" => %{"type" => "lww", "value" => value, "hlc" => hlc}}
          }
        }
      ]
    }
  end
end
