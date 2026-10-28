defmodule EbbServer.Sync.WriterOverloadHttpTest do
  @moduledoc """
  A saturated Writer answers `429` with `Retry-After` before the mailbox
  (ebbjs/ebbjs#538).
  """

  use ExUnit.Case, async: false
  use EbbServer.Integration.StorageCase, with_auth_mode: true

  alias EbbServer.Integration.ActionHelpers
  alias EbbServer.Storage.RocksDB

  @flag {__MODULE__, :block}

  def storage_writer_opts do
    test_pid = self()

    [
      max_pending_calls: 1,
      commit_fn: fn ops, opts ->
        if :persistent_term.get(@flag, false) do
          send(test_pid, {:commit_started, self()})

          receive do
            :release -> RocksDB.write_batch(ops, opts)
          end
        else
          RocksDB.write_batch(ops, opts)
        end
      end
    ]
  end

  setup do
    :persistent_term.put(@flag, false)
    on_exit(fn -> :persistent_term.erase(@flag) end)
    :ok
  end

  test "POST /sync/actions returns 429 and Retry-After when admission is full" do
    actor_id = "a_538_overload_#{:erlang.unique_integer([:positive])}"
    group_id = "g_538_overload_#{:erlang.unique_integer([:positive])}"

    :persistent_term.put(@flag, true)

    first =
      Task.async(fn ->
        ActionHelpers.bootstrap_group(actor_id, group_id, ["todo.*"])
      end)

    assert_receive {:commit_started, worker}, 2_000

    conn =
      ActionHelpers.bootstrap_group(
        "a_538_second_#{:erlang.unique_integer([:positive])}",
        "g_538_second_#{:erlang.unique_integer([:positive])}",
        ["todo.*"]
      )

    assert conn.status == 429
    assert conn.resp_body == ~s({"error":"overloaded"})
    assert get_resp_header(conn, "retry-after") == ["1"]

    send(worker, :release)

    assert %Plug.Conn{status: 200} = Task.await(first, 2_000)
  end

  defp get_resp_header(conn, header) do
    for {key, value} <- conn.resp_headers, String.downcase(key) == header, do: value
  end
end
