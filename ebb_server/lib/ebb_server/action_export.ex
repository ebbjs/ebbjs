defmodule EbbServer.ActionExport do
  @moduledoc """
  Exports durably committed Actions to an application-supplied sink.

  ## Why a consumer, not a Writer hook

  An earlier design invoked the sink inside the Writer's commit path. That
  put payload construction and an unbounded cross-process spawn on the hot
  write path, and let arbitrary server code run per client-influenced
  Action. This process instead polls the committed log off the write path:
  the Writer is untouched, and a slow, down, or hanging sink costs the
  Writer nothing.

  ## Cursor and delivery

  The cursor is durable in `EbbServer.Storage.SQLite` and named
  (`"action_export"` by default), so it survives a restart. Each `:poll`
  reads a bounded batch from the shared `EbbServer.Storage.ActionLog`
  reader up to the resolution frontier, filters it, and invokes the
  handler once per surviving Action with a timeout. The cursor advances to
  the end of the batch only if **every** invocation succeeded, which makes
  delivery at-least-once: a failed batch — or the successfully handled
  prefix of one — is re-delivered on the next poll. A handler signals
  failure by raising, throwing, exiting, or exceeding the timeout; it may
  also return `{:error, reason}`. Any of these stalls the cursor;
  `[:action_export, :lag]` is how an operator sees it.

  The cursor advances to the end of the requested range, not to the last
  Action read, so an abandoned GSN hole cannot wedge the exporter.

  ## Egress

  The exporter bypasses group authorization by design: it reads the log
  directly. System membership rows (`groupMember`, `entityGroup`) are
  stripped from the exported Updates by default, and an Action left with
  no Updates is dropped entirely.

  ## Opt-in

  Nothing starts unless `config :ebb_server, on_action: {Module, :fun}` is
  set (see `EbbServer.Application.action_export_children/0`). The handler
  receives the stored Action map — string keys, `"updates"` filtered — as
  its single argument.

  ## Example

  A logging sink is enough to watch the stream:

      config :ebb_server, on_action: {MyApp.ActionSink, :handle}

      defmodule MyApp.ActionSink do
        require Logger

        def handle(action) do
          Logger.info("[action] \#{action["id"]} by \#{action["actor_id"]}")
          :ok
        end
      end

  A handler that returns `{:error, reason}` — or raises, exits, or runs past
  the timeout — stalls the cursor and the batch is re-delivered, so keep the
  sink idempotent and dedup on `action["id"]`. A fuller warehouse sink lives
  in `examples/action_export/`.
  """

  use GenServer
  require Logger

  alias EbbServer.Storage.ActionLog
  alias EbbServer.Storage.RocksDB
  alias EbbServer.Storage.SQLite
  alias EbbServer.Storage.WatermarkTracker
  alias EbbServer.Telemetry

  @default_cursor_name "action_export"
  @default_excluded_subject_types ["groupMember", "entityGroup"]

  defstruct [
    :on_action,
    :rocks_name,
    :watermark_tracker,
    :sqlite,
    :cursor_name,
    :task_supervisor,
    :batch_size,
    :poll_interval_ms,
    :handler_timeout_ms,
    :excluded_subject_types,
    cursor: 0
  ]

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, opts, name: name)
  end

  @doc false
  @spec cursor(GenServer.server()) :: non_neg_integer()
  def cursor(server \\ __MODULE__) do
    GenServer.call(server, :cursor)
  end

  @impl true
  def init(opts) do
    state = %__MODULE__{
      on_action: Keyword.get(opts, :on_action, Application.get_env(:ebb_server, :on_action)),
      rocks_name: Keyword.get(opts, :rocks_name, RocksDB),
      watermark_tracker: Keyword.get(opts, :watermark_tracker, WatermarkTracker),
      sqlite: Keyword.get(opts, :sqlite, SQLite),
      cursor_name: Keyword.get(opts, :cursor_name, @default_cursor_name),
      task_supervisor: Keyword.get(opts, :task_supervisor, EbbServer.ActionExport.TaskSupervisor),
      batch_size: Keyword.get(opts, :batch_size, 500),
      poll_interval_ms: Keyword.get(opts, :poll_interval_ms, 1000),
      handler_timeout_ms: Keyword.get(opts, :handler_timeout_ms, 5000),
      excluded_subject_types:
        Keyword.get(opts, :excluded_subject_types, @default_excluded_subject_types)
    }

    send(self(), :poll)

    {:ok, %{state | cursor: load_cursor(state)}}
  end

  @impl true
  def handle_call(:cursor, _from, state) do
    {:reply, state.cursor, state}
  end

  # A nil handler makes the exporter inert: nothing is read and nothing is
  # emitted. Production only starts it when `:on_action` is configured (see
  # `EbbServer.Application.action_export_children/0`), so this guards
  # direct/diagnostic starts.
  @impl true
  def handle_info(:poll, %{on_action: nil} = state) do
    {:noreply, state}
  end

  def handle_info(:poll, state) do
    watermark = WatermarkTracker.committed_watermark(state.watermark_tracker)

    Telemetry.execute(
      [:action_export, :lag],
      %{lag: max(watermark - state.cursor, 0)},
      %{cursor: state.cursor}
    )

    if state.cursor >= watermark do
      schedule_poll(state)
    else
      export_batch(state, min(state.cursor + state.batch_size, watermark))
    end
  end

  defp export_batch(state, to_gsn) do
    from_gsn = state.cursor + 1

    exported =
      from_gsn
      |> ActionLog.read(to_gsn, rocks_name: state.rocks_name)
      |> filter_actions(state.excluded_subject_types)

    case invoke_handlers(exported, state) do
      :ok ->
        :ok = SQLite.put_cursor(state.cursor_name, to_gsn, state.sqlite)

        Telemetry.execute(
          [:action_export, :batch],
          %{count: length(exported)},
          %{from_gsn: from_gsn, to_gsn: to_gsn}
        )

        # Drain any backlog without waiting for the interval.
        send(self(), :poll)
        {:noreply, %{state | cursor: to_gsn}}

      {:error, gsn, reason} ->
        Logger.error(
          "Action export failed at GSN #{gsn}: #{inspect(reason)}; cursor stays at " <>
            "#{state.cursor} and the batch will be re-delivered"
        )

        Telemetry.execute([:action_export, :failed], %{count: 1}, %{gsn: gsn, reason: reason})
        schedule_poll(state)
    end
  end

  defp schedule_poll(state) do
    Process.send_after(self(), :poll, state.poll_interval_ms)
    {:noreply, state}
  end

  defp load_cursor(state) do
    case SQLite.get_cursor(state.cursor_name, state.sqlite) do
      {:ok, gsn} -> gsn
      :not_found -> 0
    end
  end

  # Rejects excluded Updates and drops an Action left with none. The count
  # is the number of Updates removed; it is only emitted when non-zero so
  # the steady state is quiet.
  defp filter_actions(actions, excluded) do
    {kept, dropped} =
      Enum.reduce(actions, {[], 0}, fn action, {kept, dropped} ->
        updates = Enum.reject(action["updates"], &(&1["subject_type"] in excluded))
        removed = length(action["updates"]) - length(updates)

        case updates do
          [] -> {kept, dropped + removed}
          _ -> {[Map.put(action, "updates", updates) | kept], dropped + removed}
        end
      end)

    kept = Enum.reverse(kept)

    if dropped > 0 do
      Telemetry.execute([:action_export, :filtered], %{count: dropped}, %{})
    end

    kept
  end

  defp invoke_handlers(actions, state) do
    Enum.reduce_while(actions, :ok, fn action, :ok ->
      case invoke_handler(action, state) do
        :ok -> {:cont, :ok}
        {:error, reason} -> {:halt, {:error, action["gsn"], reason}}
      end
    end)
  end

  # `async_nolink` plus a bounded `yield` is what keeps a hanging sink from
  # growing tasks without bound: on timeout the task is killed outright.
  defp invoke_handler(action, state) do
    task =
      Task.Supervisor.async_nolink(state.task_supervisor, fn ->
        safe_run_handler(state.on_action, action)
      end)

    case Task.yield(task, state.handler_timeout_ms) do
      {:ok, result} ->
        result

      {:exit, reason} ->
        {:error, {:handler_exit, reason}}

      nil ->
        Task.shutdown(task, :brutal_kill)
        {:error, :handler_timeout}
    end
  end

  # Handle the failure inside the task so an expected sink error exits the
  # task normally: a supervised task that crashes logs a second, noisy crash
  # report on top of the exporter's own error.
  defp safe_run_handler(handler, action) do
    case run_handler(handler, action) do
      {:error, reason} -> {:error, reason}
      _other -> :ok
    end
  rescue
    error -> {:error, {:handler_raise, error, __STACKTRACE__}}
  catch
    kind, value -> {:error, {:handler_catch, kind, value}}
  end

  defp run_handler({module, function}, action) when is_atom(module) and is_atom(function) do
    apply(module, function, [action])
  end

  defp run_handler(fun, action) when is_function(fun, 1) do
    fun.(action)
  end
end
