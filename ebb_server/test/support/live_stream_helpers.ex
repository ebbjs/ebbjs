defmodule EbbServer.LiveStreamHelpers do
  @moduledoc """
  Runs the real `GET /sync/live` route in its own process with a recording
  socket adapter, so a test asserts on the bytes the route wrote.

  The route registers its subscriber inside `open_sse/4` *after* switching the
  response to chunked mode, so committing right after `:chunked_started` could
  race the subscription. `start_live_stream/2` waits for the group's server to
  hold the connection, which makes a later delivery assertion about fan-out
  rather than scheduling.
  """

  import ExUnit.Assertions
  import Plug.Conn
  import Plug.Test

  alias EbbServer.Sync.{GroupRegistry, Router}

  @await_timeout_ms 5_000

  # Stands in for the socket the SSE handler writes to. The route's bytes are
  # forwarded to the test process, which is the only way to observe them
  # without a real connection.
  defmodule RecordingAdapter do
    @moduledoc false

    def send_chunked(%{test: test} = state, _status, _headers) do
      send(test, :chunked_started)
      {:ok, "", state}
    end

    def chunk(%{test: test} = state, body) do
      bytes = IO.iodata_to_binary(body)
      send(test, {:chunk_written, bytes})
      {:ok, bytes, state}
    end
  end

  @doc """
  Opens a live stream for `group_id` as `actor_id` and waits until the group's
  fan-out server holds the subscriber.

  The returned task must be shut down by the caller, or by test exit.
  """
  @spec start_live_stream(String.t(), String.t(), timeout()) :: Task.t()
  def start_live_stream(group_id, actor_id, timeout \\ @await_timeout_ms) do
    test_pid = self()

    conn =
      conn(:get, "/sync/live?groups=#{group_id}&cursor=0")
      |> put_req_header("x-ebb-actor-id", actor_id)
      |> Map.put(:adapter, {RecordingAdapter, %{test: test_pid}})

    task = Task.async(fn -> Router.call(conn, []) end)
    ref = Process.monitor(task.pid)

    receive do
      :chunked_started ->
        :ok

      {:DOWN, ^ref, :process, _pid, reason} ->
        flunk("the /sync/live route ended before opening a stream: #{inspect(reason)}")
    after
      timeout -> flunk("the /sync/live route never opened a stream")
    end

    Process.demonitor(ref, [:flush])
    await_subscriber(group_id, timeout)
    task
  end

  defp await_subscriber(group_id, timeout) do
    await(
      fn ->
        case GroupRegistry.lookup(group_id) do
          nil -> nil
          pid -> if subscribed?(pid), do: pid
        end
      end,
      "the SSE subscriber for #{group_id}",
      System.monotonic_time(:millisecond) + timeout
    )
  end

  defp subscribed?(pid) do
    case :sys.get_state(pid) do
      %{subscribers: subscribers} -> MapSet.size(subscribers) > 0
    end
  catch
    :exit, _reason -> false
  end

  defp await(fun, description, deadline) do
    case fun.() do
      nil ->
        if System.monotonic_time(:millisecond) > deadline do
          flunk("timed out waiting for #{description}")
        else
          Process.sleep(10)
          await(fun, description, deadline)
        end

      found ->
        found
    end
  end
end
