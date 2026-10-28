defmodule EbbServer.Sync.SSEHandlerTest do
  @moduledoc """
  Integration tests for SSEHandler and the /sync/live route.

  Uses EbbServer.Integration.StorageCase for test infrastructure.
  """

  use ExUnit.Case, async: false
  use EbbServer.Integration.StorageCase, with_auth_mode: true

  import Plug.Test
  import Plug.Conn

  alias EbbServer.Storage.{GroupCache, WatermarkTracker}
  alias EbbServer.Sync.{GroupRegistry, Router, SSEConnectionSupervisor, SSEHandler}

  @await_timeout_ms 5_000

  # Stands in for the socket. Records what `do_sse_loop/3` hands to
  # `Plug.Conn.chunk/2` so a test can assert the bytes written are the bytes
  # received, and — when the test passes a `:writes_left` counter — answers the
  # writes past that budget with `{:error, :closed}`, the way a write to a
  # client that has gone away does.
  defmodule RecordingAdapter do
    @moduledoc false

    def send_chunked(%{test: test} = state, _status, _headers) do
      send(test, :chunked_started)
      {:ok, "", state}
    end

    def chunk(%{test: test} = state, body) do
      bytes = IO.iodata_to_binary(body)
      send(test, {:chunk_written, bytes})

      if open?(state), do: {:ok, bytes, state}, else: {:error, :closed}
    end

    defp open?(%{writes_left: :infinity}), do: true

    defp open?(%{writes_left: writes_left}) do
      :counters.sub(writes_left, 1, 1)
      :counters.get(writes_left, 1) >= 0
    end
  end

  describe "open_sse/4" do
    test "returns {:error, :not_member} when actor is not a member of the group" do
      cursor = 0

      result =
        SSEHandler.open_sse(self(), ["nonexistent_group"], cursor, "stranger")

      assert result == {:error, :not_member}
    end
  end

  describe "do_sse_loop/3 data path" do
    test "writes a coalesced {:sse_data, bytes} chunk verbatim" do
      %{group_id: group_id, actor_id: actor_id} = put_member("sse_data")

      {task, loop_pid} = start_stream(actor_id, group_id, :infinity)

      bytes = "event: data\ndata: {\"id\":\"act_verbatim\"}\n\nevent: data\ndata: {}\n\n"
      send(loop_pid, {:sse_data, bytes})

      assert_receive {:chunk_written, ^bytes}, @await_timeout_ms

      Task.shutdown(task, :brutal_kill)
    end
  end

  describe "do_sse_loop/3 when the client goes away" do
    setup do
      put_member("sse_disconnect")
    end

    test "a failed :sse_data write ends the stream and releases the subscriber", %{
      group_id: group_id,
      actor_id: actor_id
    } do
      {task, loop_pid} = start_stream(actor_id, group_id, 0)
      subscription = watch_subscription(group_id)

      bytes = "event: data\ndata: {\"id\":\"act_closed\"}\n\n"
      send(loop_pid, {:sse_data, bytes})

      assert_receive {:chunk_written, ^bytes}, @await_timeout_ms
      assert Task.await(task, @await_timeout_ms) == :ok
      assert_subscriber_released(group_id, subscription)
    end

    test "an :sse_chunk event the client accepts keeps the stream open until a write fails", %{
      group_id: group_id,
      actor_id: actor_id
    } do
      {task, loop_pid} = start_stream(actor_id, group_id, 1)
      subscription = watch_subscription(group_id)

      send(loop_pid, {:sse_chunk, "control", ~s({"group":"g1","nextOffset":"502"})})

      assert_receive {:chunk_written, control}, @await_timeout_ms
      assert control == "event: control\ndata: {\"group\":\"g1\",\"nextOffset\":\"502\"}\n\n"

      # The socket's one write is spent, so the next event's write fails.
      send(loop_pid, {:sse_chunk, "presence", ~s({"actor_id":"a_peer"})})

      assert_receive {:chunk_written, presence}, @await_timeout_ms
      assert presence == "event: presence\ndata: {\"actor_id\":\"a_peer\"}\n\n"

      assert Task.await(task, @await_timeout_ms) == :ok
      assert_subscriber_released(group_id, subscription)
    end

    test "a keepalive that fails ends the stream after one that succeeds", %{
      group_id: group_id,
      actor_id: actor_id
    } do
      {task, loop_pid} = start_stream(actor_id, group_id, 1)
      subscription = watch_subscription(group_id)

      send(loop_pid, :keepalive)
      assert_receive {:chunk_written, ": keepalive\n\n"}, @await_timeout_ms

      # The first keepalive kept the loop going and spent the socket's last
      # write, so the second one's write fails and the stream ends.
      send(loop_pid, :keepalive)
      assert_receive {:chunk_written, ": keepalive\n\n"}, @await_timeout_ms

      assert Task.await(task, @await_timeout_ms) == :ok
      assert_subscriber_released(group_id, subscription)
    end

    test "the forwarding connection dying ends the stream and releases the subscriber", %{
      group_id: group_id,
      actor_id: actor_id
    } do
      {task, loop_pid} = start_stream(actor_id, group_id, :infinity)
      subscription = watch_subscription(group_id)
      connection = await_connection(loop_pid)

      Process.exit(connection, :kill)

      assert Task.await(task, @await_timeout_ms) == :ok
      refute Process.alive?(connection)
      assert_subscriber_released(group_id, subscription)
    end
  end

  describe "write_stale_cursor_response/2" do
    test "emits a control event whose data is valid JSON carrying catchUpFrom" do
      catch_up_from = 5

      conn =
        conn(:get, "/")
        |> SSEHandler.write_stale_cursor_response(catch_up_from)

      [data] =
        Regex.run(~r/^data: (.*)$/m, conn.resp_body, capture: :all_but_first)

      assert Jason.decode!(data) == %{
               "reconnect" => true,
               "reason" => "behind_watermark",
               "catchUpFrom" => catch_up_from
             }

      assert conn.resp_body ==
               "event: control\ndata: " <>
                 ~s({"reconnect":true,"reason":"behind_watermark","catchUpFrom":5}) <>
                 "\n\n"
    end

    test "returns the conn instead of raising when the client is gone" do
      conn =
        conn(:get, "/")
        |> Map.put(:adapter, {
          RecordingAdapter,
          %{test: self(), writes_left: write_budget(0)}
        })
        |> SSEHandler.write_stale_cursor_response(5)

      assert %Plug.Conn{state: :chunked} = conn
      assert conn.resp_body == ""

      assert_receive {:chunk_written, event}, @await_timeout_ms

      assert event ==
               ~s(event: control\ndata: {"reconnect":true,"reason":"behind_watermark","catchUpFrom":5}\n\n)
    end
  end

  describe "GET /sync/live" do
    test "returns 403 when actor is not a member of requested group", %{tmp_dir: _tmp_dir} do
      conn =
        conn(:get, "/sync/live?groups=some_group&cursor=0")
        |> put_req_header("x-ebb-actor-id", "outsider_actor")
        |> Router.call([])

      assert conn.status == 403
      {:ok, response} = Jason.decode(conn.resp_body)
      assert response == %{"error" => "not_member"}
    end

    test "returns 400 for invalid cursor param", %{tmp_dir: _tmp_dir} do
      actor_id = "a_test_#{:erlang.unique_integer([:positive])}"
      group_id = "g_test_#{:erlang.unique_integer([:positive])}"

      GroupCache.put_group_member(%{
        id: "gm_test",
        actor_id: actor_id,
        group_id: group_id,
        permissions: ["read"]
      })

      conn =
        conn(:get, "/sync/live?groups=#{group_id}&cursor=abc")
        |> put_req_header("x-ebb-actor-id", actor_id)
        |> Router.call([])

      assert conn.status == 400
      {:ok, response} = Jason.decode(conn.resp_body)
      assert response == %{"error" => "invalid_params"}
    end

    test "returns 400 when groups param is empty", %{tmp_dir: _tmp_dir} do
      actor_id = "a_test_#{:erlang.unique_integer([:positive])}"

      conn =
        conn(:get, "/sync/live?groups=&cursor=0")
        |> put_req_header("x-ebb-actor-id", actor_id)
        |> Router.call([])

      assert conn.status == 400
      {:ok, response} = Jason.decode(conn.resp_body)
      assert response == %{"error" => "invalid_params"}
    end

    test "a cursor ahead of the watermark sends one stale-cursor control event and halts" do
      actor_id = "a_stale_#{:erlang.unique_integer([:positive])}"
      group_id = "g_stale_#{:erlang.unique_integer([:positive])}"

      GroupCache.put_group_member(%{
        id: "gm_stale_#{:erlang.unique_integer([:positive])}",
        actor_id: actor_id,
        group_id: group_id,
        permissions: ["read"]
      })

      watermark = WatermarkTracker.committed_watermark()

      conn =
        conn(:get, "/sync/live?groups=#{group_id}&cursor=#{watermark + 5}")
        |> put_req_header("x-ebb-actor-id", actor_id)
        |> Router.call([])

      # The client resumes from the watermark, not from the cursor it claimed.
      assert conn.status == 200
      assert conn.state == :chunked
      assert conn.halted

      assert [frame] = String.split(conn.resp_body, "\n\n", trim: true)

      assert frame ==
               "event: control\ndata: " <>
                 ~s({"reconnect":true,"reason":"behind_watermark","catchUpFrom":#{watermark + 1}})
    end
  end

  # Registers a group and an actor that may read it, so `open_sse/4` admits the
  # subscription.
  defp put_member(prefix) do
    suffix = :erlang.unique_integer([:positive])
    group_id = "g_#{prefix}_#{suffix}"
    actor_id = "a_#{prefix}_#{suffix}"

    GroupCache.put_group_member(%{
      id: "gm_#{prefix}_#{suffix}",
      actor_id: actor_id,
      group_id: group_id,
      permissions: ["read"]
    })

    %{group_id: group_id, actor_id: actor_id}
  end

  # Runs `open_sse/4` the way Bandit does: a request process that blocks in the
  # loop until the stream ends. `writes_left` is how many chunk writes the
  # socket accepts before it reports the client gone.
  defp start_stream(actor_id, group_id, writes_left) do
    conn =
      Plug.Test.conn(:get, "/")
      |> Map.put(:adapter, {
        RecordingAdapter,
        %{test: self(), writes_left: write_budget(writes_left)}
      })

    test_pid = self()

    task =
      Task.async(fn ->
        send(test_pid, {:sse_loop_pid, self()})
        SSEHandler.open_sse(conn, [group_id], 0, actor_id)
      end)

    assert_receive {:sse_loop_pid, loop_pid}, @await_timeout_ms

    {task, loop_pid}
  end

  defp write_budget(:infinity), do: :infinity

  defp write_budget(count) do
    budget = :counters.new(1, [])
    :counters.put(budget, 1, count)
    budget
  end

  # A GroupServer exists only while it has subscribers and stops itself when
  # the last one leaves, so watching it is how a test sees the stream hand the
  # connection back instead of leaking it.
  defp watch_subscription(group_id) do
    group_server =
      await(fn -> GroupRegistry.lookup(group_id) end, "the group to have a subscriber")

    %{group_server: group_server, down: Process.monitor(group_server)}
  end

  defp assert_subscriber_released(group_id, %{group_server: group_server, down: down}) do
    assert_receive {:DOWN, ^down, :process, ^group_server, :normal}, @await_timeout_ms

    await(
      fn ->
        case GroupRegistry.lookup(group_id) do
          nil -> :unregistered
          _pid -> nil
        end
      end,
      "the group to be unregistered"
    )
  end

  # The connection the handler started for this request process: its exit is
  # the subscriber death the loop has to end on.
  defp await_connection(loop_pid) do
    await(
      fn ->
        SSEConnectionSupervisor
        |> DynamicSupervisor.which_children()
        |> Enum.map(fn {_id, pid, _type, _modules} -> pid end)
        |> Enum.find(&(is_pid(&1) and parent_pid(&1) == loop_pid))
      end,
      "the SSEConnection serving this stream"
    )
  end

  defp parent_pid(connection) do
    :sys.get_state(connection).parent_pid
  catch
    :exit, _ -> nil
  end

  # Polls until `fun` returns a value; a timeout fails the test rather than
  # stalling the suite.
  defp await(fun, description) do
    deadline = System.monotonic_time(:millisecond) + @await_timeout_ms
    await_until(fun, description, deadline)
  end

  defp await_until(fun, description, deadline) do
    case fun.() do
      nil ->
        if System.monotonic_time(:millisecond) > deadline do
          flunk("timed out waiting for #{description}")
        else
          Process.sleep(10)
          await_until(fun, description, deadline)
        end

      found ->
        found
    end
  end
end
