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

  ## Budgets

  `max_host_calls` bounds the calls one invocation may make. The runner refuses
  a call past the same budget before sending it, and this loop refuses one that
  nevertheless arrives: the caller gets an error reply and the invocation ends
  `429 host_call_limit`. The server counts, because the frame is the boundary
  it actually receives.

  A `log` frame is written through `EbbServer.Functions.Log` under a per
  invocation budget of `max_log_lines` and `max_log_bytes`; past either, the
  server drops frames and writes one truncation notice. A `fetch_audit` frame
  becomes a `[:ebb, :functions, :fetch]` telemetry event and a counter, never a
  stored payload. Neither can fail the invocation.

  ## Results

  Results are `{:ok, value, commit}` or
  `{:error, status, code, details, meta}`. `commit` is `nil` when the
  invocation committed nothing, and `%{replayed: boolean}` once a commit
  reached the Writer: `true` means the Action was already durable or in flight
  and no GSN was assigned — not that the first copy is proven durable. The
  last commit wins, because one invocation commits at most one Action — every
  commit in it derives the same `action_id`, so a second one is deduped.

  `meta` is `%{}` except on a rejected commit, where it carries
  `%{rejected: [...]}` — the rejection list `Host` received from
  `ActionSubmission`, in the same shape `POST /sync/actions` returns. A
  handler failure is `422 handler_error`; an oversize result is
  `413 payload_too_large`; a spent host-call budget is `429 host_call_limit`;
  every other result kind is `500 runner_error`. A host call's own code
  survives the boundary — a rejected commit is `422 rejected`, a failed read
  `500 read_failed` — so the endpoint can put it in the response envelope
  unchanged.

  ## Telemetry and reuse

  `run/1` emits `[:ebb, :functions, :invoke, :start]` and `:stop` around the
  invocation with `name`, `version`, `actor_id`, `caller_kind`, `outcome`,
  counters, `duration`, and `worker_pid`; an unexpected raise is an
  `:exception` event. A successful result *releases* the worker when its
  transport supports reuse (the pool) and closes it otherwise. Every failure
  path closes it: a worker that timed out or failed must not serve another
  caller.
  """

  alias EbbServer.Functions.{Host, Log, Protocol, Worker}

  @default_max_in_flight 8
  @default_deadline_ms 30_000
  @default_max_host_calls 1_000
  @default_max_log_lines 200
  @default_max_log_bytes 64 * 1024
  @liveness_poll_ms 100

  @type result ::
          {:ok, term(), %{replayed: boolean()} | nil}
          | {:error, pos_integer(), String.t(), String.t(), map()}
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
    * `:max_host_calls` — host-call budget (default 1000)
    * `:max_log_lines`, `:max_log_bytes` — log budget (default 200 / 64 KiB)
    * `:telemetry_meta` — `name`, `version`, `actor_id`, `caller_kind`
    * `:input_bytes` — the request's body size, for the span
  """
  @spec run(keyword()) :: result()
  def run(opts) do
    meta = Keyword.get(opts, :telemetry_meta, %{})
    started = System.monotonic_time()

    :telemetry.execute(
      [:ebb, :functions, :invoke, :start],
      %{system_time: System.system_time()},
      meta
    )

    try do
      {result, measurements} = do_run(opts)

      :telemetry.execute(
        [:ebb, :functions, :invoke, :stop],
        Map.put(measurements, :duration, System.monotonic_time() - started),
        Map.put(meta, :outcome, outcome(result))
      )

      result
    rescue
      error ->
        :telemetry.execute(
          [:ebb, :functions, :invoke, :exception],
          %{duration: System.monotonic_time() - started},
          Map.merge(meta, %{kind: :error, reason: Exception.message(error)})
        )

        reraise error, __STACKTRACE__
    catch
      kind, reason ->
        :telemetry.execute(
          [:ebb, :functions, :invoke, :exception],
          %{duration: System.monotonic_time() - started},
          Map.merge(meta, %{kind: kind, reason: inspect(reason)})
        )

        :erlang.raise(kind, reason, __STACKTRACE__)
    end
  end

  defp do_run(opts) do
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
      telemetry_meta: Keyword.get(opts, :telemetry_meta, %{}),
      max_in_flight: Keyword.get(opts, :max_in_flight, @default_max_in_flight),
      max_host_calls: Keyword.get(opts, :max_host_calls, @default_max_host_calls),
      max_log_lines: Keyword.get(opts, :max_log_lines, @default_max_log_lines),
      max_log_bytes: Keyword.get(opts, :max_log_bytes, @default_max_log_bytes),
      in_flight: %{},
      queue: :queue.new(),
      host_calls: 0,
      reads: 0,
      writes: 0,
      fetch_calls: 0,
      input_bytes: Keyword.get(opts, :input_bytes, 0),
      log_budget: Log.new_budget(),
      worker_pid: nil,
      # `nil` until a commit succeeds, then the reply's `replayed` flag. An
      # invocation commits at most one Action, so there is nothing to merge.
      commit: nil
    }

    checkout_started = System.monotonic_time()

    case Worker.start(transport, worker_opts) do
      {:ok, worker} ->
        queue_ms =
          System.convert_time_unit(
            System.monotonic_time() - checkout_started,
            :native,
            :millisecond
          )

        monitor = Worker.monitor(worker)
        deadline_ref = make_ref()

        state =
          Map.merge(state, %{
            worker: worker,
            monitor: monitor,
            deadline_ref: deadline_ref,
            queue_ms: queue_ms,
            worker_pid: Worker.os_pid(worker),
            timer: Process.send_after(self(), {:functions_deadline, deadline_ref}, deadline_ms),
            poll_ms: if(monitor, do: :infinity, else: @liveness_poll_ms)
          })

        case Worker.send_frame(worker, invoke) do
          :ok -> loop(state)
          {:error, reason} -> finish(state, unavailable(reason))
        end

      {:error, reason} ->
        {unavailable(reason), zero_measurements()}
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
          finish(state, {:error, 503, "unavailable", "worker exited before result", %{}})
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
    finish(state, {:ok, frame["value"], state.commit})
  end

  defp handle_frame(%{"type" => "result", "ok" => false} = frame, state) do
    message = frame["message"] || "handler failed"
    finish(state, result_error(frame["kind"], message))
  end

  defp handle_frame(%{"type" => "log"} = frame, state) do
    budget =
      Log.emit(
        frame["level"],
        frame["message"],
        log_meta(state),
        state.log_budget,
        state.max_log_lines,
        state.max_log_bytes
      )

    loop(%{state | log_budget: budget})
  end

  defp handle_frame(%{"type" => "fetch_audit"} = frame, state) do
    :telemetry.execute(
      [:ebb, :functions, :fetch],
      %{duration: number(frame["duration_ms"])},
      Map.merge(log_meta(state), %{
        url: frame["url"],
        status: frame["status"],
        blocked: frame["blocked"] == true
      })
    )

    loop(%{state | fetch_calls: state.fetch_calls + 1})
  end

  defp handle_frame(frame, state) do
    finish(state, protocol_error("unexpected frame: #{inspect(frame["type"])}"))
  end

  defp valid_call(%{"call_id" => call_id, "op" => op})
       when is_binary(call_id) and call_id != "" and is_binary(op) and op != "" do
    :ok
  end

  defp valid_call(_frame), do: :error

  # The budget is spent by the frame, not by a successful host result: a call
  # the server refuses to run still arrived, and a handler retrying in a loop
  # must not be able to spin forever on refusals.
  defp dispatch_or_queue(call, %{host_calls: used, max_host_calls: max} = state)
       when used >= max do
    error = %{
      "error" => "host_call_limit",
      "status" => 429,
      "details" => "the invocation spent its #{max} host calls"
    }

    _ = Worker.send_frame(state.worker, Protocol.reply(call.call_id, {:error, error}))
    finish(state, {:error, 429, "host_call_limit", error["details"], %{}})
  end

  defp dispatch_or_queue(call, state) do
    state = %{state | host_calls: state.host_calls + 1}

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

    in_flight =
      Map.put(state.in_flight, pid, %{monitor: monitor, call_id: call_id, op: op})

    %{state | in_flight: in_flight}
  end

  defp handle_host_result(pid, _call_id, result, state) do
    case Map.pop(state.in_flight, pid) do
      {nil, _in_flight} ->
        loop(state)

      {%{monitor: monitor, call_id: call_id, op: op}, in_flight} ->
        Process.demonitor(monitor, [:flush])

        state =
          state
          |> Map.put(:in_flight, in_flight)
          |> count_op(op, result)
          |> record_commit(op, result)

        reply_and_continue(call_id, result, state)
    end
  end

  defp count_op(state, "get", {:ok, _value}), do: %{state | reads: state.reads + 1}
  defp count_op(state, "commit", {:ok, _value}), do: %{state | writes: state.writes + 1}
  defp count_op(state, _op, _result), do: state

  # Only a successful commit says anything about the invocation's writes; a
  # failing one ends the invocation with the host's own error.
  defp record_commit(state, "commit", {:ok, %{"replayed" => replayed}})
       when is_boolean(replayed) do
    %{state | commit: %{replayed: replayed}}
  end

  defp record_commit(state, _op, _result), do: state

  defp reply_and_continue(call_id, {:ok, value}, state) do
    case Worker.send_frame(state.worker, Protocol.reply(call_id, {:ok, value})) do
      :ok -> loop(fill_slots(state))
      {:error, reason} -> finish(state, unavailable(reason))
    end
  end

  defp reply_and_continue(call_id, {:error, error}, state) do
    _ = Worker.send_frame(state.worker, Protocol.reply(call_id, {:error, error}))
    finish(state, host_error(error))
  end

  defp reply_and_continue(call_id, _other, state) do
    error = %{
      "error" => "host_call_failed",
      "status" => 500,
      "details" => "host call returned an invalid result"
    }

    _ = Worker.send_frame(state.worker, Protocol.reply(call_id, {:error, error}))
    finish(state, {:error, 500, "host_call_failed", error["details"], %{}})
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
    finish(
      state,
      {:error, 503, "unavailable", "worker exited before result: #{inspect(reason)}", %{}}
    )
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
          {:error, 500, "host_call_failed", error["details"], %{}}
        )
    end
  end

  defp find_in_flight(in_flight, monitor) do
    Enum.find(in_flight, fn {_pid, %{monitor: ref}} -> ref == monitor end)
  end

  defp handle_deadline(ref, %{deadline_ref: ref} = state) do
    finish(state, {:error, 408, "timeout", "deadline exceeded", %{}})
  end

  defp handle_deadline(_ref, state), do: loop(state)

  # A successful result returns the worker to a pooling transport; every
  # other result kills it, because it may still be running the handler.
  defp finish(state, result) do
    Process.cancel_timer(state.timer)

    if state.monitor do
      Process.demonitor(state.monitor, [:flush])
    end

    Enum.each(state.in_flight, fn {pid, %{monitor: monitor}} ->
      Process.demonitor(monitor, [:flush])
      Process.exit(pid, :kill)
    end)

    release_or_close(state.worker, result)
    flush_deadline(state.deadline_ref)
    {result, measurements(state, result)}
  end

  defp release_or_close(worker, {:ok, _value, _commit}), do: Worker.release(worker)
  defp release_or_close(worker, _result), do: Worker.close(worker)

  defp measurements(state, result) do
    %{
      host_calls: state.host_calls,
      reads: state.reads,
      writes: state.writes,
      fetch_calls: state.fetch_calls,
      queue_ms: state.queue_ms || 0,
      worker_pid: state.worker_pid,
      log_lines: state.log_budget.lines,
      log_bytes: state.log_budget.bytes,
      input_bytes: state.input_bytes || 0,
      output_bytes: output_bytes(result)
    }
  end

  defp zero_measurements do
    %{
      host_calls: 0,
      reads: 0,
      writes: 0,
      fetch_calls: 0,
      queue_ms: 0,
      worker_pid: nil,
      log_lines: 0,
      log_bytes: 0,
      input_bytes: 0,
      output_bytes: 0
    }
  end

  defp output_bytes({:ok, value, _commit}) do
    IO.iodata_length(Jason.encode_to_iodata!(value))
  rescue
    _error -> 0
  end

  defp output_bytes(_result), do: 0

  defp flush_deadline(deadline_ref) do
    receive do
      {:functions_deadline, ^deadline_ref} -> :ok
    after
      0 -> :ok
    end
  end

  defp result_error("handler_error", message), do: {:error, 422, "handler_error", message, %{}}

  defp result_error("output_too_large", message) do
    {:error, 413, "payload_too_large", message, %{}}
  end

  defp result_error("host_call_limit", message) do
    {:error, 429, "host_call_limit", message, %{}}
  end

  defp result_error(_kind, message), do: {:error, 500, "runner_error", message, %{}}

  # A host call answers in the envelope's vocabulary already: `Host` builds
  # `%{"error" => code, "status" => status, "details" => text}`. Carrying that
  # code through keeps a rejected commit (`rejected`) distinct from a thrown
  # handler (`handler_error`) instead of flattening both into one 422. A
  # rejection's structured list rides along so the endpoint can publish it.
  defp host_error(%{"status" => status, "error" => code} = error)
       when is_integer(status) and is_binary(code) do
    details =
      case error["details"] do
        text when is_binary(text) and text != "" -> text
        _ -> code
      end

    {:error, status, code, details, error_meta(error)}
  end

  defp host_error(_error),
    do: {:error, 500, "host_call_failed", "host call failed", %{}}

  defp error_meta(%{"rejected" => [_ | _] = rejected}), do: %{rejected: rejected}
  defp error_meta(_error), do: %{}

  defp protocol_error(message), do: {:error, 500, "protocol_error", message, %{}}

  defp unavailable(:saturated) do
    {:error, 503, "saturated", "all workers are busy; retry shortly", %{}}
  end

  defp unavailable(reason),
    do: {:error, 503, "unavailable", "worker unavailable: #{inspect(reason)}", %{}}

  defp outcome({:ok, _value, _commit}), do: :ok
  defp outcome({:error, 408, _code, _details, _meta}), do: :timeout
  defp outcome({:error, 503, "saturated", _details, _meta}), do: :saturated
  defp outcome(_result), do: :error

  defp log_meta(state) do
    Map.merge(
      %{
        name: Map.get(state.telemetry_meta, :name, "unknown"),
        version: Map.get(state.telemetry_meta, :version, "unknown"),
        invocation_id: state.context.invocation_id
      },
      %{}
    )
  end

  defp number(value) when is_number(value), do: value
  defp number(_value), do: 0
end
