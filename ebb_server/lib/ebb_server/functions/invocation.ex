defmodule EbbServer.Functions.Invocation do
  @moduledoc """
  Drives one worker through one invocation.

  The loop sends `invoke`, answers `call` frames until `result`, and owns the
  deadline timer. Host calls are keyed by `call_id` and may be answered in any
  order; the loop matches a host result to the call it started, never to the
  next frame in line. `max_in_flight` caps how many host calls run at once, and
  `1` is exactly serial. The cap is a resource knob: v1's only ops are a pure
  read and one commit at return, so concurrency cannot change an Action's
  contents.

  A frame that arrives after `result` or after the deadline is discarded, never
  answered. A worker that dies without a `result` ends the invocation without
  taking the caller down. A host call that fails is answered and then ends the
  invocation: a read is v1's only pure op and a commit is fail-whole, so there
  is no state in which continuing could produce a correct result.

  Results are `{:ok, value}` or `{:error, status, details}`. A `handler_error`
  result is `422`; every other result kind is `500`. The taxonomy is open, so
  the mapping is one exhaustive function here rather than a case at each call
  site. The HTTP envelope that carries these codes is #680's.
  """

  alias EbbServer.Functions.{Host, Protocol, Worker}

  @default_max_in_flight 8
  @default_deadline_ms 30_000
  @liveness_poll_ms 100

  @type result :: {:ok, term()} | {:error, pos_integer(), String.t()}
  @type context :: %{required(:actor_id) => term(), required(:invocation_id) => term()}

  @doc """
  Runs one invocation.

  Options:

    * `:transport` — required worker transport module
    * `:invoke` — required `invoke` frame
    * `:worker_opts` — passed to the transport
    * `:host` — module implementing `dispatch/4` (default `Host`)
    * `:host_opts` — passed to the host module
    * `:max_in_flight` — concurrent host calls (default 8, `1` serial)
    * `:deadline_ms` — wall-clock budget (default 30 s)
  """
  @spec run(keyword()) :: result()
  def run(opts) do
    invoke = Keyword.fetch!(opts, :invoke)
    transport = Keyword.fetch!(opts, :transport)
    deadline_ms = Keyword.get(opts, :deadline_ms, @default_deadline_ms)

    context = %{
      actor_id: invoke["subject_actor_id"],
      invocation_id: invoke["invocation_id"]
    }

    worker_opts = Keyword.put(Keyword.get(opts, :worker_opts, []), :owner, self())

    state = %{
      host: Keyword.get(opts, :host, Host),
      host_opts: Keyword.get(opts, :host_opts, []),
      context: context,
      max_in_flight: Keyword.get(opts, :max_in_flight, @default_max_in_flight),
      in_flight: %{},
      queue: :queue.new()
    }

    case Worker.start(transport, worker_opts) do
      {:ok, worker} ->
        monitor = Worker.monitor(worker)
        deadline_ref = make_ref()

        state =
          Map.merge(state, %{
            worker: worker,
            monitor: monitor,
            deadline_ref: deadline_ref,
            timer: Process.send_after(self(), {:functions_deadline, deadline_ref}, deadline_ms),
            poll_ms: if(monitor, do: :infinity, else: @liveness_poll_ms)
          })

        case Worker.send_frame(worker, invoke) do
          :ok -> loop(state)
          {:error, reason} -> finish(state, unavailable(reason))
        end

      {:error, reason} ->
        unavailable(reason)
    end
  end

  defp loop(state) do
    receive do
      {:functions_worker_frame, frame} ->
        handle_frame(frame, state)

      {:functions_host_result, pid, call_id, result} ->
        handle_host_result(pid, call_id, result, state)

      {:DOWN, ref, :process, _pid, reason} ->
        handle_down(ref, reason, state)

      {:functions_deadline, ref} ->
        handle_deadline(ref, state)
    after
      state.poll_ms ->
        if Worker.alive?(state.worker) do
          loop(state)
        else
          finish(state, {:error, 503, "worker exited before result"})
        end
    end
  end

  defp handle_frame(%{"type" => "ready"} = frame, state) do
    if Protocol.compatible_version?(frame["protocol_version"]) do
      loop(state)
    else
      finish(
        state,
        protocol_error("unsupported protocol version: #{inspect(frame["protocol_version"])}")
      )
    end
  end

  defp handle_frame(%{"type" => "call"} = frame, state) do
    case valid_call(frame) do
      :ok ->
        call = %{call_id: frame["call_id"], op: frame["op"], payload: frame["payload"]}
        dispatch_or_queue(call, state)

      :error ->
        finish(state, protocol_error("malformed call frame"))
    end
  end

  defp handle_frame(%{"type" => "result", "ok" => true} = frame, state) do
    finish(state, {:ok, frame["value"]})
  end

  defp handle_frame(%{"type" => "result", "ok" => false} = frame, state) do
    message = frame["message"] || "handler failed"
    finish(state, {:error, result_status(frame["kind"]), message})
  end

  # `log` and `fetch_audit` are part of the wire contract but not of v1. They are
  # fire-and-forget, so an older host ignores them rather than failing.
  defp handle_frame(%{"type" => type}, state) when type in ["log", "fetch_audit"] do
    loop(state)
  end

  defp handle_frame(frame, state) do
    finish(state, protocol_error("unexpected frame: #{inspect(frame["type"])}"))
  end

  defp valid_call(%{"call_id" => call_id, "op" => op})
       when is_binary(call_id) and call_id != "" and is_binary(op) and op != "" do
    :ok
  end

  defp valid_call(_frame), do: :error

  defp dispatch_or_queue(call, state) do
    if map_size(state.in_flight) < state.max_in_flight do
      loop(start_host_call(call, state))
    else
      loop(%{state | queue: :queue.in(call, state.queue)})
    end
  end

  defp start_host_call(%{call_id: call_id, op: op, payload: payload}, state) do
    parent = self()
    host = state.host
    host_opts = state.host_opts
    context = state.context

    {pid, monitor} =
      spawn_monitor(fn ->
        result = host.dispatch(op, payload, context, host_opts)
        send(parent, {:functions_host_result, self(), call_id, result})
      end)

    in_flight = Map.put(state.in_flight, pid, %{monitor: monitor, call_id: call_id})
    %{state | in_flight: in_flight}
  end

  defp handle_host_result(pid, _call_id, result, state) do
    case Map.pop(state.in_flight, pid) do
      {nil, _in_flight} ->
        loop(state)

      {%{monitor: monitor, call_id: call_id}, in_flight} ->
        Process.demonitor(monitor, [:flush])
        state = %{state | in_flight: in_flight}
        reply_and_continue(call_id, result, state)
    end
  end

  defp reply_and_continue(call_id, {:ok, value}, state) do
    case Worker.send_frame(state.worker, Protocol.reply(call_id, {:ok, value})) do
      :ok -> loop(fill_slots(state))
      {:error, reason} -> finish(state, unavailable(reason))
    end
  end

  defp reply_and_continue(call_id, {:error, error}, state) do
    _ = Worker.send_frame(state.worker, Protocol.reply(call_id, {:error, error}))
    finish(state, {:error, error_status(error), error_details(error)})
  end

  defp reply_and_continue(call_id, _other, state) do
    error = %{
      "error" => "host_call_failed",
      "status" => 500,
      "details" => "host call returned an invalid result"
    }

    _ = Worker.send_frame(state.worker, Protocol.reply(call_id, {:error, error}))
    finish(state, {:error, 500, error["details"]})
  end

  defp fill_slots(state) do
    if map_size(state.in_flight) < state.max_in_flight do
      case :queue.out(state.queue) do
        {{:value, call}, queue} -> fill_slots(start_host_call(call, %{state | queue: queue}))
        {:empty, _queue} -> state
      end
    else
      state
    end
  end

  defp handle_down(ref, reason, %{monitor: ref} = state) do
    finish(state, {:error, 503, "worker exited before result: #{inspect(reason)}"})
  end

  defp handle_down(ref, _reason, state) do
    case find_in_flight(state.in_flight, ref) do
      nil ->
        loop(state)

      {pid, %{call_id: call_id}} ->
        error = %{
          "error" => "host_call_failed",
          "status" => 500,
          "details" => "host call failed"
        }

        _ = Worker.send_frame(state.worker, Protocol.reply(call_id, {:error, error}))

        finish(
          %{state | in_flight: Map.delete(state.in_flight, pid)},
          {:error, 500, error["details"]}
        )
    end
  end

  defp find_in_flight(in_flight, monitor) do
    Enum.find(in_flight, fn {_pid, %{monitor: ref}} -> ref == monitor end)
  end

  defp handle_deadline(ref, %{deadline_ref: ref} = state) do
    finish(state, {:error, 408, "deadline exceeded"})
  end

  defp handle_deadline(_ref, state), do: loop(state)

  defp finish(state, result) do
    Process.cancel_timer(state.timer)

    if state.monitor do
      Process.demonitor(state.monitor, [:flush])
    end

    Enum.each(state.in_flight, fn {pid, %{monitor: monitor}} ->
      Process.demonitor(monitor, [:flush])
      Process.exit(pid, :kill)
    end)

    Worker.close(state.worker)
    flush_deadline(state.deadline_ref)
    result
  end

  defp flush_deadline(deadline_ref) do
    receive do
      {:functions_deadline, ^deadline_ref} -> :ok
    after
      0 -> :ok
    end
  end

  defp result_status("handler_error"), do: 422
  defp result_status(_kind), do: 500

  defp error_status(%{"status" => status}) when is_integer(status), do: status
  defp error_status(_error), do: 500

  defp error_details(%{"details" => details}) when is_binary(details), do: details
  defp error_details(%{"error" => code}), do: to_string(code)
  defp error_details(_error), do: "host call failed"

  defp protocol_error(message), do: {:error, 500, message}

  defp unavailable(reason), do: {:error, 503, "worker unavailable: #{inspect(reason)}"}
end
