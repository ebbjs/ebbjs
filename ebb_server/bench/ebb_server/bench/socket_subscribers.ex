defmodule EbbServer.Bench.SocketSubscribers do
  @moduledoc """
  Real-socket SSE subscribers for tiers T3 and T4, run as separate OS
  processes.

  Each subscriber is one real `GET /sync/live` connection over loopback TCP,
  owned by an `EbbServer.Bench.SocketClient` running in its own BEAM, so the
  consumer's CPU is not on the server's schedulers. That is the difference
  from `EbbServer.Bench.Subscriber`: the in-process subscriber shares four
  schedulers with the Writer and the GroupServers, so its cost is inside the
  server's measured fan-out.

  The OS processes are launched with the same `elixir` binary, `-pa` pointing
  at this build's ebin, and talk to this module over stdin/stdout in the
  line protocol documented in `EbbServer.Bench.SocketClient`. Connection setup
  happens before the measured window: `start_all/3` returns only once every
  socket has its SSE response head, and it returns the instant the warmup
  clock should start. The measured window's start and deadline are then handed
  to the clients as absolute instants, so a late control line shortens the
  window instead of shifting it.

  Per-chunk receive → parse → count samples stay in the client process in a
  bounded reservoir and cross the port raw at the end; `stop_all/1` merges
  them and computes the percentiles over the merged samples, never by
  averaging per-process percentiles.
  """

  alias EbbServer.Bench.{Metrics, Options}

  @entry "EbbServer.Bench.SocketClient.main(System.argv())"
  @ready_timeout_ms 60_000
  @stop_timeout_ms 120_000

  @type report :: %{
          port: port(),
          connections: non_neg_integer(),
          buffer: binary(),
          delivered: non_neg_integer(),
          data_chunks: non_neg_integer(),
          control: non_neg_integer(),
          holes: non_neg_integer(),
          errors: non_neg_integer(),
          bytes_total: non_neg_integer(),
          lats: [integer()],
          lags: [integer()],
          clock_us: integer() | nil,
          skew_us: integer(),
          done?: boolean(),
          bye?: boolean(),
          exit: term()
        }

  @type t :: %{
          collector: pid(),
          delivered: :atomics.atomics_ref(),
          subscribers: pos_integer(),
          processes: pos_integer(),
          measure_start: integer()
        }

  @doc """
  Starts `count` real SSE connections across the requested number of OS
  processes and waits until every one of them is streaming.

  Returns `nil` for zero subscribers. Options are `:port` (required),
  `:processes` (`0` means the auto rule in `EbbServer.Bench.Options`),
  `:warmup` and `:duration` in seconds. The returned `:measure_start` is the
  instant the warmup window begins, computed once the connections are ready.
  """
  @spec start_all(non_neg_integer(), map(), keyword()) :: t() | nil
  def start_all(0, _ctx, _opts), do: nil

  def start_all(count, ctx, opts) when count > 0 do
    processes = processes(count, opts)
    delivered = :atomics.new(1, signed: true)
    caller = self()

    config = %{
      port: Keyword.fetch!(opts, :port),
      group_id: ctx.group_id,
      actor_id: ctx.actor_id,
      connections: count,
      processes: processes,
      warmup_us: Keyword.get(opts, :warmup, 0) * 1_000_000,
      duration_us: Keyword.get(opts, :duration, 0) * 1_000_000
    }

    collector = spawn_link(fn -> collector_init(caller, config, delivered) end)

    receive do
      {:socket_ready, ^collector, measure_start, connected} ->
        if connected < count do
          abort(
            collector,
            "socket subscribers: #{connected} of #{count} SSE connections came up; " <>
              "the client reported connection errors"
          )
        end

        %{
          collector: collector,
          delivered: delivered,
          subscribers: count,
          processes: processes,
          measure_start: measure_start
        }

      {:socket_failed, ^collector, reason} ->
        abort(collector, "socket subscribers failed to start: #{inspect(reason)}")
    after
      @ready_timeout_ms ->
        abort(collector, "socket subscribers did not become ready")
    end
  end

  # The collector is linked, and a failed start is caught by the runner in the
  # same process, so it has to be taken down explicitly: otherwise the client
  # OS processes outlive the pass that could not use them.
  defp abort(collector, message) do
    Process.unlink(collector)
    Process.exit(collector, :kill)
    raise message
  end

  @doc """
  Cumulative frames the clients have counted, for the sampler.

  `nil` without subscribers, like `EbbServer.Bench.Subscriber.delivered/1`.
  The value comes from shared atomics the collector updates from the clients'
  progress lines, so polling it never blocks on a client.
  """
  @spec delivered(t() | nil) :: non_neg_integer() | nil
  def delivered(nil), do: nil
  def delivered(%{delivered: ref}), do: :atomics.get(ref, 1)

  @doc """
  Stops the clients and returns the merged client summary.

  The summary carries the keys the report and the guardrails read:
  `:subscribers`, `:processes`, `:delivered_total`, `:data_chunks`,
  `:control_total`, `:holes`, `:errors`, `:client_p50`, `:client_p95`,
  `:client_p99`, `:client_samples`, `:lag_p50`, `:lag_p99`, `:lag_samples`,
  `:bytes_total`.
  """
  @spec stop_all(t() | nil) :: map() | nil
  def stop_all(nil), do: nil

  def stop_all(%{collector: collector}) do
    ref = Process.monitor(collector)
    send(collector, {:stop, self()})

    receive do
      {:socket_summary, ^collector, summary} ->
        Process.demonitor(ref, [:flush])
        summary

      {:DOWN, ^ref, :process, ^collector, reason} ->
        raise "socket subscriber collector died before reporting: #{inspect(reason)}"
    after
      @stop_timeout_ms -> raise "socket subscribers did not report within #{@stop_timeout_ms}ms"
    end
  end

  @doc """
  Merges per-process client reports into the run summary.

  Percentiles are nearest-rank over the raw samples of every process merged
  and sorted, so a process that sampled more chunks (or a busier subscriber)
  is not flattened into an average of averages.
  """
  @spec summarize(Enumerable.t()) :: map()
  def summarize(reports) do
    reports = Enum.to_list(reports)
    lats = reports |> Enum.flat_map(& &1.lats) |> Enum.sort()
    lags = reports |> Enum.flat_map(& &1.lags) |> Enum.sort()

    %{
      subscribers: sum(reports, :connections),
      processes: length(reports),
      delivered_total: sum(reports, :delivered),
      data_chunks: sum(reports, :data_chunks),
      control_total: sum(reports, :control),
      holes: sum(reports, :holes),
      errors: sum(reports, :errors),
      client_p50: Metrics.percentile(lats, 50),
      client_p95: Metrics.percentile(lats, 95),
      client_p99: Metrics.percentile(lats, 99),
      client_samples: length(lats),
      lag_p50: Metrics.percentile(lags, 50),
      lag_p99: Metrics.percentile(lags, 99),
      lag_samples: length(lags),
      bytes_total: sum(reports, :bytes_total)
    }
  end

  @doc """
  Splits `count` connections over `processes` client processes.

  The remainder is spread over the first processes, so the counts differ by at
  most one and always add up to `count`.
  """
  @spec connections_per_process(pos_integer(), pos_integer()) :: [non_neg_integer()]
  def connections_per_process(count, processes) when count > 0 and processes > 0 do
    base = div(count, processes)
    extra = rem(count, processes)
    Enum.map(0..(processes - 1)//1, fn index -> if index < extra, do: base + 1, else: base end)
  end

  @doc """
  Applies one client protocol line to that client's report.

  Unknown lines are ignored so a stray line from a future client cannot
  corrupt the accounting.
  """
  @spec apply_line(report(), String.t()) :: report()
  def apply_line(report, "ok " <> rest) do
    case String.split(rest) do
      [connections, clock_us] ->
        clock = String.to_integer(clock_us)

        %{
          report
          | connections: String.to_integer(connections),
            clock_us: clock,
            skew_us: clock - now()
        }

      _other ->
        report
    end
  end

  def apply_line(report, "progress " <> rest) do
    case String.split(rest) do
      [_clock_us, delivered] -> %{report | delivered: String.to_integer(delivered)}
      _other -> report
    end
  end

  def apply_line(report, "done " <> rest) do
    case rest |> String.split() |> Enum.map(&Integer.parse/1) do
      [
        {delivered, ""},
        {data_chunks, ""},
        {control, ""},
        {holes, ""},
        {errors, ""},
        {bytes_total, ""}
      ] ->
        %{
          report
          | delivered: delivered,
            data_chunks: data_chunks,
            control: control,
            holes: holes,
            errors: errors,
            bytes_total: bytes_total,
            done?: true
        }

      _other ->
        report
    end
  end

  def apply_line(report, "lat " <> rest), do: %{report | lats: report.lats ++ samples(rest)}
  def apply_line(report, "lag " <> rest), do: %{report | lags: report.lags ++ samples(rest)}
  def apply_line(report, "bye"), do: %{report | bye?: true}
  def apply_line(report, _line), do: report

  defp samples(rest) do
    case String.split(rest, " ", parts: 2) do
      [_count, values] -> values |> String.split(",") |> Enum.map(&sample/1)
      _other -> []
    end
  end

  defp sample(value) do
    case Integer.parse(value) do
      {sample, ""} -> sample
      _other -> 0
    end
  end

  defp sum(reports, key), do: Enum.reduce(reports, 0, &(Map.fetch!(&1, key) + &2))

  defp processes(count, opts) do
    case Keyword.get(opts, :processes, 0) do
      requested when is_integer(requested) and requested > 0 -> min(requested, count)
      _auto -> Options.auto_socket_processes(count)
    end
  end

  defp collector_init(caller, config, delivered) do
    state = %{
      caller: caller,
      config: config,
      delivered: delivered,
      ports: %{},
      ready?: false,
      measure_start: nil
    }

    case await_ready(open_ports(state), now() + @ready_timeout_ms * 1_000) do
      {:ok, state} ->
        measure_start = now() + config.warmup_us
        send(caller, {:socket_ready, self(), measure_start, connected(state)})
        state = schedule_window(state, measure_start)
        loop(state)

      {:error, reason} ->
        close_ports(state)
        send(caller, {:socket_failed, self(), reason})
    end
  rescue
    error -> send(caller, {:socket_failed, self(), Exception.message(error)})
  catch
    kind, reason -> send(caller, {:socket_failed, self(), {kind, reason}})
  end

  defp open_ports(state) do
    config = state.config

    ports =
      config.connections
      |> connections_per_process(config.processes)
      |> Enum.map(fn connections ->
        port = open_port(config, connections)
        {port, new_report(port, connections)}
      end)

    %{state | ports: Map.new(ports)}
  end

  defp open_port(config, connections) do
    executable = System.find_executable("elixir") || raise "elixir executable not found"

    args = [
      "-pa",
      ebin_dir(),
      "-e",
      @entry,
      Integer.to_string(config.port),
      config.group_id,
      config.actor_id,
      Integer.to_string(connections)
    ]

    Port.open({:spawn_executable, executable}, [
      :binary,
      :exit_status,
      :use_stdio,
      {:args, args},
      {:cd, System.tmp_dir()}
    ])
  end

  defp ebin_dir, do: Application.app_dir(:ebb_server, "ebin")

  defp new_report(port, connections) do
    %{
      port: port,
      connections: connections,
      buffer: "",
      delivered: 0,
      data_chunks: 0,
      control: 0,
      holes: 0,
      errors: 0,
      bytes_total: 0,
      lats: [],
      lags: [],
      clock_us: nil,
      skew_us: 0,
      done?: false,
      bye?: false,
      exit: nil
    }
  end

  defp await_ready(state, deadline) do
    ports = state.ports

    cond do
      connected(state) >= state.config.connections ->
        {:ok, state}

      now() >= deadline ->
        {:error, :ready_timeout}

      Enum.any?(state.ports, fn {_port, report} -> report.exit != nil end) ->
        {:error, {:client_exited, exit_reasons(state)}}

      true ->
        receive do
          {port, {:data, data}} when is_map_key(ports, port) ->
            await_ready(port_data(state, port, data), deadline)

          {port, {:exit_status, status}} when is_map_key(ports, port) ->
            await_ready(port_exit(state, port, {:exit_status, status}), deadline)

          {port, :closed} when is_map_key(ports, port) ->
            await_ready(port_exit(state, port, :closed), deadline)
        after
          max(div(deadline - now(), 1_000), 0) -> {:error, :ready_timeout}
        end
    end
  end

  defp connected(state) do
    Enum.reduce(state.ports, 0, fn {_port, report}, acc -> acc + streaming(report) end)
  end

  defp streaming(%{clock_us: nil}), do: 0
  defp streaming(%{connections: connections}), do: connections

  defp exit_reasons(state) do
    Enum.flat_map(state.ports, fn
      {_port, %{exit: nil}} -> []
      {_port, %{exit: exit}} -> [exit]
    end)
  end

  defp schedule_window(state, measure_start) do
    deadline = measure_start + state.config.duration_us
    delay = div(max(measure_start - now(), 0), 1000)
    Process.send_after(self(), {:open_window, measure_start, deadline}, delay)
    %{state | measure_start: measure_start}
  end

  defp loop(state) do
    ports = state.ports

    receive do
      {port, {:data, data}} when is_map_key(ports, port) ->
        state = state |> port_data(port, data) |> publish()
        loop(state)

      {port, {:exit_status, status}} when is_map_key(ports, port) ->
        loop(port_exit(state, port, {:exit_status, status}))

      {port, :closed} when is_map_key(ports, port) ->
        loop(port_exit(state, port, :closed))

      {:open_window, measure_start, deadline} ->
        open_window(state, measure_start, deadline)
        loop(state)

      {:stop, caller} ->
        finish(state, caller)
    end
  end

  defp open_window(state, measure_start, deadline) do
    Enum.each(state.ports, fn {port, report} ->
      skew = report.skew_us
      command(port, "start #{measure_start + skew} #{deadline + skew} #{skew}\n")
    end)
  end

  defp finish(state, caller) do
    Enum.each(state.ports, fn {port, _report} -> command(port, "stop\n") end)
    state = await_done(state, now() + @stop_timeout_ms * 1_000)
    send(caller, {:socket_summary, self(), summarize(finished_reports(state))})
    close_ports(state)
  end

  defp finished_reports(state) do
    Enum.map(state.ports, fn {_port, report} ->
      # A client that never said `bye` lost the run: count it as a client
      # error so the guardrail gate fails instead of reporting fewer frames.
      errors = if report.bye? or report.errors > 0, do: report.errors, else: report.errors + 1
      %{report | errors: errors}
    end)
  end

  defp await_done(state, deadline) do
    ports = state.ports

    cond do
      Enum.all?(state.ports, fn {_port, report} -> report.bye? or report.exit != nil end) ->
        state

      now() >= deadline ->
        state

      true ->
        receive do
          {port, {:data, data}} when is_map_key(ports, port) ->
            await_done(port_data(state, port, data), deadline)

          {port, {:exit_status, status}} when is_map_key(ports, port) ->
            await_done(port_exit(state, port, {:exit_status, status}), deadline)

          {port, :closed} when is_map_key(ports, port) ->
            await_done(port_exit(state, port, :closed), deadline)
        after
          max(div(deadline - now(), 1_000), 0) -> state
        end
    end
  end

  defp port_data(state, port, data) do
    report = Map.fetch!(state.ports, port)
    {buffer, lines} = lines(report.buffer <> data)
    report = Enum.reduce(lines, %{report | buffer: buffer}, &apply_line(&2, &1))
    %{state | ports: Map.put(state.ports, port, report)}
  end

  defp lines(buffer) do
    case :binary.split(buffer, "\n") do
      [line, rest] ->
        {remaining, lines} = lines(rest)
        {remaining, [line | lines]}

      [remaining] ->
        {remaining, []}
    end
  end

  defp port_exit(state, port, exit) do
    report = Map.fetch!(state.ports, port)
    %{state | ports: Map.put(state.ports, port, %{report | exit: exit})}
  end

  defp publish(state) do
    :atomics.put(state.delivered, 1, Enum.reduce(state.ports, 0, &(frame(&1) + &2)))
    state
  end

  defp frame({_port, report}), do: report.delivered

  defp close_ports(state) do
    Enum.each(state.ports, fn {port, _report} ->
      try do
        Port.close(port)
      rescue
        ArgumentError -> :ok
      end
    end)
  end

  defp command(port, line) do
    Port.command(port, line)
  rescue
    ArgumentError -> false
  end

  defp now, do: System.monotonic_time(:microsecond)
end
