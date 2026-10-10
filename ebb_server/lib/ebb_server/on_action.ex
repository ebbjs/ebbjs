defmodule EbbServer.OnAction do
  @moduledoc """
  Developer-facing `onAction` hook: dispatches each durably committed
  Action to an application-supplied handler, off the write path.

  ## Configuration

  Configure a handler through the application environment:

      config :ebb_server, on_action: {MyApp.Actions, :handle}

  The handler is either a `{module, function}` tuple naming a public
  1-arity function or a 1-arity anonymous function. `nil` (the default)
  disables the hook. The Writer resolves this once at startup, so
  changing it requires a restart.

  ## Payload

  Each invocation receives one map:

      %{
        id: "act_...",
        actor_id: "a_...",
        hlc: 1_710_000_000_000_000,
        gsn: 42,
        updates: [%{id: ..., subject_id: ..., subject_type: ..., method: ..., data: ...}],
        groups: ["g_...", ...]
      }

  `updates` is the commit's validated Update list (`method` is an atom).
  `groups` is the group set the Writer resolved for this Action using the
  same snapshot that built the `cf_group_actions` index — the same set
  fan-out indexes against.

  ## Semantics

  The hook is **best-effort**:

  - It runs on a supervised task after the commit is durable, so it never
    blocks the write or affects its ack. A slow handler only delays its
    own task.
  - Delivery is at-most-once on the local node. An Action id is globally
    unique, so consumers can dedupe replays themselves.
  - Invocations may arrive out of GSN order; each payload still carries
    the Action's own GSN.
  - A handler that raises, throws, or exits is logged and dropped. It
    never crashes the dispatcher or the Writer.
  - Actions received via replication do not fire the hook yet; it fires
    only for locally committed Actions.

  ## Supervision

  `EbbServer.Application` starts `{Task.Supervisor, name: EbbServer.OnAction.Supervisor}`
  before the storage tree. The Writer enqueues one task per committed
  batch; the tasks are `:temporary`, and a handler failure is caught
  before it can crash a task.
  """

  require Logger

  @supervisor EbbServer.OnAction.Supervisor

  @type handler :: (payload() -> any()) | {module(), atom()}
  @type payload :: %{
          id: String.t(),
          actor_id: String.t(),
          hlc: non_neg_integer(),
          gsn: non_neg_integer(),
          updates: [map()],
          groups: [String.t()]
        }

  @doc """
  Dispatches `payloads` to `handler` on a single supervised task.

  One task per committed batch keeps the Writer's critical path to a
  single spawn: the handler for each payload runs in the task, not in the
  Writer. Never blocks on the handler and never raises — a missing
  dispatcher, a `start_child` failure, or a handler failure is swallowed
  (the latter is logged), so callers on the commit path cannot be
  affected by the hook.
  """
  @spec dispatch_all(handler() | nil, [payload()]) :: :ok
  def dispatch_all(nil, _payloads), do: :ok
  def dispatch_all(_handler, []), do: :ok

  def dispatch_all(handler, payloads) do
    case Process.whereis(@supervisor) do
      nil -> :ok
      _pid -> start_task(handler, payloads)
    end

    :ok
  end

  defp start_task(handler, payloads) do
    _ =
      Task.Supervisor.start_child(@supervisor, fn ->
        Enum.each(payloads, &invoke(handler, &1))
      end)

    :ok
  catch
    # The dispatcher can go down between the lookup and the call.
    :exit, _reason -> :ok
  end

  defp invoke(handler, payload) do
    case handler do
      fun when is_function(fun, 1) -> fun.(payload)
      {module, function} -> apply(module, function, [payload])
    end

    :ok
  rescue
    error ->
      log_failure(handler, Exception.format(:error, error, __STACKTRACE__))
  catch
    kind, value ->
      log_failure(handler, Exception.format(kind, value, __STACKTRACE__))
  end

  defp log_failure(handler, formatted) do
    Logger.error("onAction handler #{inspect(handler)} failed: #{formatted}")
  end
end
