defmodule EbbServer.RestartReadIntegrationTest do
  @moduledoc """
  End-to-end regression for #564: dirty marks are ETS-only, so a restart used
  to leave `GET /entities/:id` serving a stale row and `POST /entities/query`
  missing a never-materialized one.

  Writes and reads go through the real Router. The read model is inspected
  directly in SQLite first, so the test proves the bug condition before it
  restarts `Storage.Supervisor` on the same data dir, then relies only on the
  boot path to repair it — no mocks and no forced materialization.
  """

  use ExUnit.Case, async: false
  use EbbServer.Integration.StorageCase

  import EbbServer.Integration.ActionHelpers
  import EbbServer.Integration.QueryHelpers
  import EbbServer.TestHelpers, only: [hlc_from: 2]

  alias EbbServer.Storage.{DirtyTracker, EntityStore, SQLite}

  @storage_children [
    EbbServer.Storage.RocksDB,
    EbbServer.Storage.SQLite,
    EbbServer.Storage.SystemCache,
    EbbServer.Storage.WatermarkTracker,
    EbbServer.Storage.InFlightActions,
    EbbServer.Storage.Writer
  ]

  setup do
    suffix = Integer.to_string(System.unique_integer([:positive]))
    actor_id = "a_restart_" <> suffix
    group_id = "g_restart_" <> suffix

    assert_rejected_empty!(
      bootstrap_group(actor_id, group_id, ["todo.create", "todo.update", "todo.read"])
    )

    %{
      actor_id: actor_id,
      group_id: group_id,
      todo_stale: "todo_stale_" <> suffix,
      todo_missing: "todo_missing_" <> suffix
    }
  end

  test "a restart repairs the SQLite read model behind GET and query", ctx do
    %{
      actor_id: actor_id,
      group_id: group_id,
      todo_stale: todo_stale,
      todo_missing: todo_missing,
      tmp_dir: tmp_dir
    } = ctx

    base_hlc = System.os_time(:millisecond)

    write_entity!(actor_id, todo_stale, group_id, "Draft", hlc_from(base_hlc, 0))

    conn = get_entity(todo_stale, actor_id)
    assert conn.status == 200
    before_restart = Jason.decode!(conn.resp_body)
    assert field(before_restart, "title") == "Draft"

    # Patched after its last read: only an in-memory dirty mark stands between
    # SQLite and staleness.
    patch_entity!(actor_id, todo_stale, "Patched", hlc_from(base_hlc, 1))

    # Committed but never read: no SQLite row at all.
    write_entity!(actor_id, todo_missing, group_id, "Never read", hlc_from(base_hlc, 2))

    # The bug condition, proved against the read model itself: the stale row
    # still carries the pre-patch title, the other rows were never written.
    assert {:ok, stale_row} = SQLite.get_entity(todo_stale, EbbServer.Storage.SQLite)
    assert stale_row.last_gsn == before_restart["last_gsn"]
    assert title_of(stale_row) == "Draft"

    assert :not_found = SQLite.get_entity(todo_missing, EbbServer.Storage.SQLite)
    # The bootstrap group row was never read, so it covers the missing-group
    # case as well.
    assert :not_found = SQLite.get_entity(group_id, EbbServer.Storage.SQLite)

    restart_storage!(tmp_dir)

    conn = get_entity(todo_stale, actor_id)
    assert conn.status == 200
    stale = Jason.decode!(conn.resp_body)
    assert field(stale, "title") == "Patched"
    assert stale["last_gsn"] > before_restart["last_gsn"]

    conn = get_entity(todo_missing, actor_id)
    assert conn.status == 200
    missing = Jason.decode!(conn.resp_body)
    assert field(missing, "title") == "Never read"
    assert missing["last_gsn"] > before_restart["last_gsn"]

    conn = post_query(%{"type" => "todo"}, actor_id)
    assert conn.status == 200
    queried_ids = conn.resp_body |> Jason.decode!() |> Enum.map(& &1["id"])
    assert todo_stale in queried_ids
    assert todo_missing in queried_ids

    # `GET /entities/:id` cannot authorize a group (it has no entityGroup row),
    # so the group's durability is checked through the read API directly.
    assert {:ok, group} = EntityStore.get(group_id, actor_id)
    assert group.type == "group"
    assert get_in(group.data, ["fields", "name", "value"]) == "Test Group"
  end

  defp write_entity!(actor_id, entity_id, group_id, title, hlc) do
    action = %{
      "id" => "act_put_" <> Nanoid.generate(),
      "actor_id" => actor_id,
      "hlc" => hlc,
      "updates" => [
        %{
          "id" => "upd_put_" <> Nanoid.generate(),
          "subject_id" => entity_id,
          "subject_type" => "todo",
          "method" => "put",
          "data" => %{
            "fields" => %{"title" => %{"type" => "lww", "value" => title, "hlc" => hlc}}
          }
        },
        entity_group_update(entity_id, group_id, hlc)
      ]
    }

    assert_rejected_empty!(post_actions(msgpack_encode!(%{"actions" => [action]}), actor_id))
  end

  defp patch_entity!(actor_id, entity_id, title, hlc) do
    action = %{
      "id" => "act_patch_" <> Nanoid.generate(),
      "actor_id" => actor_id,
      "hlc" => hlc,
      "updates" => [
        %{
          "id" => "upd_patch_" <> Nanoid.generate(),
          "subject_id" => entity_id,
          "subject_type" => "todo",
          "method" => "patch",
          "data" => %{
            "fields" => %{"title" => %{"type" => "lww", "value" => title, "hlc" => hlc}}
          }
        }
      ]
    }

    assert_rejected_empty!(post_actions(msgpack_encode!(%{"actions" => [action]}), actor_id))
  end

  defp assert_rejected_empty!(conn) do
    assert conn.status == 200
    assert Jason.decode!(conn.resp_body) == %{"rejected" => []}
  end

  defp field(entity, name), do: get_in(entity, ["data", "fields", name, "value"])

  defp title_of(row), do: row.data |> Jason.decode!() |> get_in(["fields", "title", "value"])

  # Stop the whole storage tree cleanly, then reopen it on the same data dir.
  # Dirty marks live in ETS and are gone, so only the boot path can repair the
  # read model from here.
  defp restart_storage!(data_dir) do
    supervisor = Process.whereis(EbbServer.Storage.Supervisor)
    assert is_pid(supervisor)

    :ok = Supervisor.stop(supervisor, :normal, 5_000)
    assert :ets.info(DirtyTracker.dirty_set_name()) == :undefined
    await_unregistered(@storage_children)
    release_rocksdb_handle(EbbServer.Storage.RocksDB)

    {:ok, _pid} =
      EbbServer.Storage.Supervisor.start_link(data_dir: data_dir, writer_opts: [])

    :ok
  end

  # `EbbServer.Storage.RocksDB` does not trap exits, so `Supervisor.stop/3`
  # kills it without running `terminate/2`: the NIF handle outlives it in
  # `:persistent_term` and keeps the LOCK file. Close it the way `terminate/2`
  # would, or reopening the same data dir fails with "lock hold by current
  # process".
  defp release_rocksdb_handle(name) do
    :rocksdb.close(EbbServer.Storage.RocksDB.db_ref(name))
  rescue
    _ -> :ok
  end

  # `Supervisor.stop/3` waits for its children, but poll the names instead of
  # assuming they are already free when the call returns.
  defp await_unregistered(names, attempts \\ 100) do
    case Enum.filter(names, &Process.whereis/1) do
      [] ->
        :ok

      remaining when attempts > 0 ->
        Process.sleep(5)
        await_unregistered(remaining, attempts - 1)

      remaining ->
        flunk("storage children still registered after shutdown: #{inspect(remaining)}")
    end
  end
end
