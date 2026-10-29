defmodule EbbServer.Bench.SocketClient do
  @moduledoc """
  The SSE consumer that runs in its own OS process for `--subscriber-socket`.

  `EbbServer.Bench.SocketSubscribers` starts one of these per
  `--socket-processes`; it opens `connections` real `GET /sync/live` streams
  over loopback TCP and reports what arrived. It can also be run by hand
  against a booted bench server:

      elixir -pa ebb_server/_build/dev/lib/ebb_server/ebin \
        -e "EbbServer.Bench.SocketClient.main(System.argv())" \
        4111 g_bench a_bench 100 5 25

  The positional arguments are `port group_id actor_id connections warmup_s
  duration_s`; that form times its own window and prints a summary instead of
  the control lines.

  Nothing here boots `:ebb_server` or touches storage. The wire is plain
  HTTP/1.1 over `:gen_tcp` with chunked transfer encoding, decoded by hand, so
  the receive → parse → count cost this module measures is the client half of
  the published fan-out number.

  The hot path never JSON-decodes a frame: it counts `event: data` occurrences
  and pulls the `gsn` integer out of the payload, which is all the delivery
  accounting and the hole gate need. `bench_sent_us` is only searched for on
  the frames sampled for delivery lag.

  ## Control protocol

  Lines are newline-delimited ASCII in both directions. The parent sends
  `start <local_start_us> <local_deadline_us> <clock_skew_us>` and `stop`; the
  client answers `ok <connections> <clock_us>`, `progress <clock_us>
  <delivered>`, and at the end `done <field>...`, `lat ...`, `lag ...`,
  `bye`.

  The window instants arrive already converted into this process's monotonic
  clock, and the skew lets lag samples subtract the difference between the two
  VMs' clocks, so neither number depends on the two VMs agreeing on an epoch.
  """

  @recv_timeout_ms 500
  @connect_timeout_ms 5_000
  @progress_ms 250
  @drain_ms 150
  @collect_timeout_ms 5_000
  @ready_settle_ms 50
  @sample_cap 200
  @lag_cap 50
  @lag_stride 50
  @max_head_bytes 16_384
  @max_frame_buffer_bytes 1_000_000
  @sample_batch 1_000

  @counter_delivered 1
  @counter_data_chunks 2
  @counter_control 3
  @counter_holes 4
  @counter_errors 5
  @counter_bytes 6
  @counter_slots 6

  @window_start 1
  @window_deadline 2
  @window_skew 3
  @window_open 4

  @type conn :: %{
          chunk_buffer: binary(),
          frame_buffer: binary(),
          last_gsn: non_neg_integer() | nil,
          holes: non_neg_integer(),
          frames_seen: non_neg_integer()
        }
  @type counts :: %{
          data: non_neg_integer(),
          control: non_neg_integer(),
          holes: non_neg_integer(),
          bytes: non_neg_integer(),
          lag_frame: binary() | nil
        }
  @type reservoir :: %{
          samples: [integer()],
          count: non_neg_integer(),
          seen: non_neg_integer(),
          cap: pos_integer()
        }

  @doc """
  Entry point for the `-e` expression; see the moduledoc for the arguments.
  """
  @spec main([String.t()]) :: :ok
  def main(args) do
    run(parse_args!(args))
  end

  @doc "A fresh connection state for one SSE stream."
  @spec new_conn() :: conn()
  def new_conn do
    %{chunk_buffer: "", frame_buffer: "", last_gsn: nil, holes: 0, frames_seen: 0}
  end

  @doc "A fresh bounded sample container."
  @spec new_reservoir(pos_integer()) :: reservoir()
  def new_reservoir(cap), do: %{samples: [], count: 0, seen: 0, cap: cap}

  @doc """
  Adds one sample, keeping at most `cap` of them (Algorithm R).

  The per-connection reservoir is what bounds how much raw data crosses the
  control port: every connection receives the same number of chunks, so
  merging the per-connection reservoirs is a uniform sample of the run.
  """
  @spec reservoir_add(reservoir(), integer()) :: reservoir()
  def reservoir_add(%{count: count, cap: cap} = reservoir, sample) when count < cap do
    %{reservoir | samples: [sample | reservoir.samples], count: count + 1, seen: count + 1}
  end

  def reservoir_add(%{cap: cap, seen: seen} = reservoir, sample) do
    if :rand.uniform(seen + 1) <= cap do
      index = :rand.uniform(cap) - 1
      %{reservoir | samples: List.replace_at(reservoir.samples, index, sample), seen: seen + 1}
    else
      %{reservoir | seen: seen + 1}
    end
  end

  defp parse_args!([port, group_id, actor_id, connections]) do
    %{
      port: String.to_integer(port),
      group_id: group_id,
      actor_id: actor_id,
      connections: parse_connections(connections),
      warmup_us: 0,
      duration_us: nil
    }
  end

  defp parse_args!([port, group_id, actor_id, connections, warmup_s, duration_s]) do
    %{
      port: String.to_integer(port),
      group_id: group_id,
      actor_id: actor_id,
      connections: parse_connections(connections),
      warmup_us: String.to_integer(warmup_s) * 1_000_000,
      duration_us: String.to_integer(duration_s) * 1_000_000
    }
  end

  defp parse_args!(args) do
    raise ArgumentError,
          "expected port group_id actor_id connections [warmup_s duration_s], got: #{inspect(args)}"
  end

  defp parse_connections(value), do: value |> String.to_integer() |> max(0)

  defp run(config) do
    parent = self()

    state = %{
      config: config,
      counters: :counters.new(@counter_slots, [:write_concurrency]),
      window: :atomics.new(4, signed: true),
      connections: [],
      streaming: 0,
      failed: 0,
      finished: %{},
      ready?: false
    }

    spawn_link(fn -> read_stdin(parent) end)

    state =
      Enum.reduce(1..config.connections//1, state, fn _, acc ->
        counters = acc.counters
        window = acc.window
        pid = spawn_link(fn -> connection(parent, counters, window, config) end)
        %{acc | connections: [pid | acc.connections]}
      end)

    loop(state)
  end

  defp read_stdin(parent) do
    case IO.gets(:stdio, "") do
      :eof ->
        send(parent, :stdin_eof)

      {:error, _reason} ->
        send(parent, :stdin_eof)

      line ->
        send(parent, {:control, String.trim(line)})
        read_stdin(parent)
    end
  end

  defp loop(state) do
    receive do
      {:streaming, _pid} ->
        loop(streaming(state))

      {:connect_failed, _pid, _reason} ->
        loop(%{state | failed: state.failed + 1})

      {:finished, pid, samples, lags} ->
        loop(%{state | finished: Map.put(state.finished, pid, {samples, lags})})

      {:control, "start " <> window} ->
        loop(open_window(state, window))

      {:control, "stop"} ->
        finalize(state)

      :stdin_eof ->
        finalize(state)

      :finalize ->
        finalize(state)

      :progress ->
        say("progress #{now()} #{delivered(state.counters)}")
        Process.send_after(self(), :progress, @progress_ms)
        loop(state)
    end
  end

  # Readiness is "every socket has its SSE response head": the server
  # subscribes the connection microseconds after it commits the response, and
  # the settle keeps the first batch from racing that subscribe.
  defp streaming(state) do
    state = %{state | streaming: state.streaming + 1}

    if state.ready? or state.streaming + state.failed < state.config.connections do
      state
    else
      Process.sleep(@ready_settle_ms)
      say("ok #{state.streaming} #{now()}")
      Process.send_after(self(), :progress, @progress_ms)
      state = %{state | ready?: true}
      if state.config.duration_us, do: schedule_manual_window(state), else: state
    end
  end

  defp schedule_manual_window(state) do
    start_us = now() + state.config.warmup_us
    set_window(state, start_us, start_us + state.config.duration_us, 0)
    schedule_finalize(state.config.duration_us)
    state
  end

  defp open_window(state, window) do
    case String.split(window) do
      [start_us, deadline_us, skew_us] ->
        start_us = String.to_integer(start_us)
        deadline_us = String.to_integer(deadline_us)
        set_window(state, start_us, deadline_us, String.to_integer(skew_us))
        schedule_finalize(deadline_us - now())
        state

      _other ->
        state
    end
  end

  # The window instants live in this process's clock domain, which is not
  # necessarily positive (`:erlang.monotonic_time/0` has an undefined epoch),
  # so "opened" is its own flag rather than a sign test on the start instant.
  defp set_window(state, start_us, deadline_us, skew_us) do
    :atomics.put(state.window, @window_start, start_us)
    :atomics.put(state.window, @window_deadline, deadline_us)
    :atomics.put(state.window, @window_skew, skew_us)
    :atomics.put(state.window, @window_open, 1)
  end

  defp schedule_finalize(remaining_us) do
    Process.send_after(self(), :finalize, div(max(remaining_us, 0), 1000) + @drain_ms)
  end

  defp finalize(state) do
    Enum.each(state.connections, &send(&1, :collect))
    {samples, lags, missing} = gather(state, now() + @collect_timeout_ms * 1_000)

    counters = state.counters
    errors = :counters.get(counters, @counter_errors) + missing

    say(
      "done #{delivered(counters)} #{:counters.get(counters, @counter_data_chunks)} " <>
        "#{:counters.get(counters, @counter_control)} " <>
        "#{:counters.get(counters, @counter_holes)} #{errors} " <>
        "#{:counters.get(counters, @counter_bytes)}"
    )

    emit_samples("lat", samples)
    emit_samples("lag", lags)
    say("bye")
    if state.config.duration_us, do: print_summary(state, samples, lags, errors)
    :ok
  end

  defp gather(state, deadline) do
    missing = max(state.streaming - map_size(state.finished), 0)

    if missing == 0 or now() >= deadline do
      {samples, lags} = collect_samples(state.finished)
      {samples, lags, missing}
    else
      receive do
        {:finished, pid, samples, lags} ->
          finished = Map.put(state.finished, pid, {samples, lags})
          gather(%{state | finished: finished}, deadline)
      after
        max(deadline - now(), 0) -> gather(state, deadline)
      end
    end
  end

  defp collect_samples(finished) do
    {samples, lags} =
      finished
      |> Map.values()
      |> Enum.reduce({[], []}, fn {samples, lags}, {all_samples, all_lags} ->
        {samples ++ all_samples, lags ++ all_lags}
      end)

    {Enum.sort(samples), Enum.sort(lags)}
  end

  defp emit_samples(_label, []), do: :ok

  defp emit_samples(label, samples) do
    samples
    |> Enum.chunk_every(@sample_batch)
    |> Enum.each(fn batch -> say("#{label} #{length(batch)} #{Enum.join(batch, ",")}") end)
  end

  defp print_summary(state, samples, lags, errors) do
    say(
      "# #{state.streaming} connection(s): #{delivered(state.counters)} frames, " <>
        "#{:counters.get(state.counters, @counter_holes)} GSN holes, #{errors} errors, " <>
        "client p50/p95/p99 (µs) #{percentiles(samples, [50, 95, 99])}, " <>
        "lag p50/p99 (µs) #{percentiles(lags, [50, 99])}"
    )
  end

  defp percentiles([], _requested), do: "n/a"

  defp percentiles(sorted, requested) do
    Enum.map_join(requested, "/", &Integer.to_string(percentile(sorted, &1)))
  end

  defp percentile(sorted, p) do
    n = length(sorted)
    Enum.at(sorted, min(max(ceil(p / 100 * n), 1), n) - 1)
  end

  defp delivered(counters), do: :counters.get(counters, @counter_delivered)

  defp now, do: System.monotonic_time(:microsecond)

  defp say(line), do: IO.puts(:stdio, line)

  defp connection(parent, counters, window, config) do
    case :gen_tcp.connect(
           ~c"127.0.0.1",
           config.port,
           [:binary, active: false, nodelay: true],
           @connect_timeout_ms
         ) do
      {:ok, socket} ->
        with :ok <- :gen_tcp.send(socket, request(config)),
             {:ok, buffer} <- await_head(socket, "") do
          send(parent, {:streaming, self()})
          body(socket, connection_state(parent, counters, window), buffer)
        else
          {:error, reason} -> fail(parent, counters, reason)
        end

      {:error, reason} ->
        fail(parent, counters, reason)
    end
  end

  defp connection_state(parent, counters, window) do
    %{
      parent: parent,
      counters: counters,
      window: window,
      conn: new_conn(),
      samples: new_reservoir(@sample_cap),
      lags: new_reservoir(@lag_cap)
    }
  end

  defp fail(parent, counters, reason) do
    :counters.add(counters, @counter_errors, 1)
    send(parent, {:connect_failed, self(), reason})
    :ok
  end

  defp request(config) do
    path = "/sync/live?groups=#{URI.encode_www_form(config.group_id)}&cursor=0"

    [
      "GET #{path} HTTP/1.1\r\n",
      "host: 127.0.0.1:#{config.port}\r\n",
      "accept: text/event-stream\r\n",
      "cache-control: no-cache\r\n",
      "x-ebb-actor-id: #{config.actor_id}\r\n",
      "connection: keep-alive\r\n",
      "\r\n"
    ]
  end

  defp await_head(socket, buffer) do
    case :gen_tcp.recv(socket, 0, @connect_timeout_ms) do
      {:ok, data} -> head_result(parse_response_head(buffer <> data), socket)
      {:error, reason} -> {:error, reason}
    end
  end

  defp head_result({:more, rest}, socket), do: await_head(socket, rest)

  defp head_result({:ok, 200, headers, rest}, _socket) do
    if chunked?(headers), do: {:ok, rest}, else: {:error, {:not_chunked, headers}}
  end

  defp head_result({:ok, status, _headers, _rest}, _socket), do: {:error, {:http_status, status}}
  defp head_result({:error, reason}, _socket), do: {:error, reason}

  defp body(socket, state, buffer) do
    # The mailbox is polled per read, not only on an idle timeout: a
    # subscriber at a published rate may never time out between reads, and a
    # `:collect` left queued would strand its samples.
    case poll() do
      :stop -> finish(state)
      :cont -> body_loop(socket, state, buffer)
    end
  end

  defp poll do
    receive do
      :collect -> :stop
    after
      0 -> :cont
    end
  end

  defp body_loop(socket, state, buffer) do
    case :gen_tcp.recv(socket, 0, @recv_timeout_ms) do
      {:ok, data} ->
        parse_started_at = now()

        case ingest(state.conn, buffer <> data) do
          {:ok, counts, leftover, conn} ->
            state = record(%{state | conn: conn}, counts, parse_started_at, now())
            body(socket, state, leftover)

          {:error, _reason} ->
            :counters.add(state.counters, @counter_errors, 1)
            finish(state)
        end

      {:error, :timeout} ->
        case deadline_passed?(state) do
          true -> finish(state)
          false -> body(socket, state, buffer)
        end

      {:error, _reason} ->
        :counters.add(state.counters, @counter_errors, 1)
        finish(state)
    end
  end

  defp deadline_passed?(state) do
    :atomics.get(state.window, @window_open) == 1 and
      now() >= :atomics.get(state.window, @window_deadline) + @drain_ms * 1_000
  end

  defp finish(state) do
    send(state.parent, {:finished, self(), state.samples.samples, state.lags.samples})
    :ok
  end

  @doc """
  Decodes one transport read into counts, the leftover buffers, and the GSN
  state after it. The caller stamps the read around this call, so the sample
  is the parse work this module exists to price.
  """
  @spec ingest(conn(), binary()) :: {:ok, counts(), binary(), conn()} | {:error, term()}
  def ingest(conn, bytes) do
    conn = %{conn | chunk_buffer: conn.chunk_buffer <> bytes}

    case decode_chunked(conn.chunk_buffer) do
      {:ok, _chunks, _rest, :done} ->
        {:error, :stream_ended}

      {:ok, chunks, rest, :more} ->
        frame_buffer = conn.frame_buffer <> IO.iodata_to_binary(chunks)

        if byte_size(frame_buffer) > @max_frame_buffer_bytes do
          {:error, :frame_buffer_overflow}
        else
          {counts, leftover, conn} = consume(frame_buffer, conn)
          counts = %{counts | bytes: IO.iodata_length(chunks)}
          {:ok, counts, leftover, %{conn | chunk_buffer: rest, frame_buffer: leftover}}
        end

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp record(state, counts, parse_started_at, parsed_at) do
    counters = state.counters
    :counters.add(counters, @counter_delivered, counts.data)
    :counters.add(counters, @counter_data_chunks, if(counts.data > 0, do: 1, else: 0))
    :counters.add(counters, @counter_control, counts.control)
    :counters.add(counters, @counter_holes, counts.holes)
    :counters.add(counters, @counter_bytes, counts.bytes)

    state
    |> sample_latency(parsed_at - parse_started_at, parsed_at)
    |> sample_lag(counts.lag_frame, parsed_at)
  end

  defp in_window?(state, at_us) do
    :atomics.get(state.window, @window_open) == 1 and
      at_us >= :atomics.get(state.window, @window_start) and
      at_us < :atomics.get(state.window, @window_deadline)
  end

  defp sample_latency(state, sample, at_us) do
    if in_window?(state, at_us),
      do: %{state | samples: reservoir_add(state.samples, sample)},
      else: state
  end

  defp sample_lag(state, nil, _at_us), do: state

  defp sample_lag(state, frame, at_us) do
    with true <- in_window?(state, at_us),
         sent_us when is_integer(sent_us) <- frame_sent_us(frame),
         lag when lag >= 0 <- at_us - sent_us - :atomics.get(state.window, @window_skew) do
      %{state | lags: reservoir_add(state.lags, lag)}
    else
      _ -> state
    end
  end

  @doc """
  Parses the HTTP response head out of `buffer`.

  `{:more, rest}` means the head is not complete yet; `{:ok, status, headers,
  rest}` returns the headers with lowercased names and the first body byte.
  """
  @spec parse_response_head(binary()) ::
          {:more, binary()} | {:ok, non_neg_integer(), map(), binary()} | {:error, term()}
  def parse_response_head(buffer) do
    case :binary.match(buffer, "\r\n\r\n") do
      :nomatch ->
        if byte_size(buffer) > @max_head_bytes,
          do: {:error, :head_too_large},
          else: {:more, buffer}

      {position, 4} ->
        head = binary_part(buffer, 0, position)
        rest = binary_part(buffer, position + 4, byte_size(buffer) - position - 4)

        with [status_line | header_lines] <- String.split(head, "\r\n"),
             {:ok, status} <- parse_status(status_line) do
          {:ok, status, parse_headers(header_lines), rest}
        else
          {:error, reason} -> {:error, reason}
          [] -> {:error, :empty_response}
        end
    end
  end

  defp parse_status(status_line) do
    with ["HTTP/" <> _version, status | _rest] <- String.split(status_line, " "),
         {code, ""} <- Integer.parse(status) do
      {:ok, code}
    else
      _ -> {:error, {:bad_status_line, status_line}}
    end
  end

  defp parse_headers(lines) do
    Enum.reduce(lines, %{}, fn line, headers ->
      case String.split(line, ":", parts: 2) do
        [name, value] -> Map.put(headers, String.downcase(String.trim(name)), String.trim(value))
        _other -> headers
      end
    end)
  end

  @doc "Whether the response headers announce chunked transfer encoding."
  @spec chunked?(map()) :: boolean()
  def chunked?(headers) do
    headers
    |> Map.get("transfer-encoding", "")
    |> String.downcase()
    |> String.contains?("chunked")
  end

  @doc """
  Decodes the complete HTTP chunks in `buffer`.

  Returns the decoded payloads, the unparsed remainder, and whether the
  terminating zero-length chunk was seen. A partial chunk stays in the
  remainder untouched, so a caller can hand the next read in.
  """
  @spec decode_chunked(binary()) :: {:ok, [binary()], binary(), :more | :done} | {:error, term()}
  def decode_chunked(buffer), do: decode_chunks(buffer, [])

  defp decode_chunks(buffer, acc) do
    case :binary.match(buffer, "\r\n") do
      :nomatch ->
        {:ok, Enum.reverse(acc), buffer, :more}

      {position, 2} ->
        size_line = binary_part(buffer, 0, position)
        rest = binary_part(buffer, position + 2, byte_size(buffer) - position - 2)

        case chunk_size(size_line) do
          {:ok, 0} ->
            {:ok, Enum.reverse(acc), strip_terminator(rest), :done}

          {:ok, size} when byte_size(rest) >= size + 2 ->
            payload = binary_part(rest, 0, size)
            rest = binary_part(rest, size + 2, byte_size(rest) - size - 2)
            decode_chunks(rest, [payload | acc])

          {:ok, _size} ->
            {:ok, Enum.reverse(acc), buffer, :more}

          :error ->
            {:error, {:bad_chunk_size, size_line}}
        end
    end
  end

  # The zero-length chunk is followed by the trailer terminator, which carries
  # nothing this client reads.
  defp strip_terminator("\r\n" <> rest), do: rest
  defp strip_terminator(rest), do: rest

  defp chunk_size(size_line) do
    case size_line |> String.split(";") |> hd() |> String.trim() |> Integer.parse(16) do
      {size, ""} -> {:ok, size}
      _other -> :error
    end
  end

  @doc """
  Splits complete SSE events out of `buffer` on the blank-line terminator.
  """
  @spec split_frames(binary()) :: {[binary()], binary()}
  def split_frames(buffer), do: split_frames(buffer, [])

  defp split_frames(buffer, acc) do
    case :binary.match(buffer, "\n\n") do
      :nomatch ->
        {Enum.reverse(acc), buffer}

      {position, 2} ->
        frame = binary_part(buffer, 0, position)
        rest = binary_part(buffer, position + 2, byte_size(buffer) - position - 2)
        split_frames(rest, [frame | acc])
    end
  end

  @doc """
  Classifies one SSE event: `:data`, `:control`, or `:comment`.
  """
  @spec frame_kind(binary()) :: :data | :control | :comment
  def frame_kind(frame) do
    case first_line(frame) do
      "event: data" -> :data
      "event: " <> _type -> :control
      ":" <> _comment -> :comment
      "data:" <> _payload -> :data
      _other -> :comment
    end
  end

  defp first_line(frame) do
    case :binary.match(frame, "\n") do
      :nomatch -> frame
      {position, 1} -> binary_part(frame, 0, position)
    end
  end

  @doc """
  The `gsn` an Action frame carries, read without decoding the payload.

  The frame is `event: data\\ndata: {"id":...,"gsn":N,...}`; the value is an
  integer literal, so the digits after the key are the whole answer.
  """
  @spec frame_gsn(binary()) :: non_neg_integer() | nil
  def frame_gsn(frame) do
    case :binary.match(frame, ~s("gsn":)) do
      {position, length} ->
        frame |> binary_part(position + length, byte_size(frame) - position - length) |> integer()

      :nomatch ->
        nil
    end
  end

  @doc """
  The workbook's `bench_sent_us` stamp, read without decoding the payload.

  The field is `"bench_sent_us":{"hlc":...,"type":"lww","value":N}`, so the
  search is for the key and then for its `"value"`.
  """
  @spec frame_sent_us(binary()) :: non_neg_integer() | nil
  def frame_sent_us(frame) do
    with {position, length} <- :binary.match(frame, ~s("bench_sent_us":)),
         tail = binary_part(frame, position + length, byte_size(frame) - position - length),
         {value_position, value_length} <- :binary.match(tail, ~s("value":)) do
      tail
      |> binary_part(
        value_position + value_length,
        byte_size(tail) - value_position - value_length
      )
      |> integer()
    else
      _nomatch -> nil
    end
  end

  # Monotonic stamps can be negative (`erlang:monotonic_time/0` has an
  # undefined, per-VM epoch), so a leading sign is part of the number.
  defp integer(binary) do
    case skip_non_digits(binary) do
      "" ->
        nil

      <<?-, digits::binary>> ->
        case Integer.parse(digits) do
          {value, _rest} -> -value
          :error -> nil
        end

      digits ->
        case Integer.parse(digits) do
          {value, _rest} -> value
          :error -> nil
        end
    end
  end

  defp skip_non_digits(<<?-, digit, rest::binary>>) when digit in ?0..?9 do
    <<?-, digit, rest::binary>>
  end

  defp skip_non_digits(<<byte, rest::binary>>) when byte not in ?0..?9, do: skip_non_digits(rest)
  defp skip_non_digits(binary), do: binary

  @doc """
  Advances the per-connection GSN watermark and counts discontinuities.

  A GSN higher than the last one by more than one is a hole of the difference
  minus one. An equal GSN is the same Action delivered again (per-Update
  frames share it), not a hole. A lower GSN is out of order and counts as one
  discontinuity, so wire reordering fails the same gate a loss does.
  """
  @spec advance_gsn(conn(), non_neg_integer()) :: conn()
  def advance_gsn(%{last_gsn: nil} = conn, gsn), do: %{conn | last_gsn: gsn}

  def advance_gsn(%{last_gsn: last} = conn, gsn) when gsn > last do
    %{conn | last_gsn: gsn, holes: conn.holes + (gsn - last - 1)}
  end

  def advance_gsn(%{last_gsn: last} = conn, gsn) when gsn == last, do: conn
  def advance_gsn(conn, _gsn), do: %{conn | holes: conn.holes + 1}

  @doc """
  Splits complete frames out of `buffer`, counting each by kind.

  `lag_frame` is the last frame that fell on the delivery-lag sampling stride,
  if any; the caller decodes `bench_sent_us` from it and nothing else.
  """
  @spec consume(binary(), conn()) :: {counts(), binary(), conn()}
  def consume(buffer, conn) do
    {frames, leftover} = split_frames(buffer)
    holes_before = conn.holes

    {counts, conn} =
      Enum.reduce(
        frames,
        {%{data: 0, control: 0, holes: 0, bytes: 0, lag_frame: nil}, conn},
        &count_frame/2
      )

    {%{counts | holes: conn.holes - holes_before}, leftover, conn}
  end

  defp count_frame(frame, {counts, conn}) do
    case frame_kind(frame) do
      :data ->
        conn = %{conn | frames_seen: conn.frames_seen + 1}

        conn =
          case frame_gsn(frame) do
            nil -> conn
            gsn -> advance_gsn(conn, gsn)
          end

        lag_frame =
          if rem(conn.frames_seen, @lag_stride) == 0, do: frame, else: counts.lag_frame

        {%{counts | data: counts.data + 1, lag_frame: lag_frame}, conn}

      :control ->
        {%{counts | control: counts.control + 1}, conn}

      :comment ->
        {counts, conn}
    end
  end
end
