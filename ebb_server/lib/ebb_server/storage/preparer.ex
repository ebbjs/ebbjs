defmodule EbbServer.Storage.Preparer do
  @moduledoc """
  One prepare worker: builds and ETF-encodes the GSN-free Action payload
  away from the sequencer.

  A prepare job carries only what the storage payload needs — `id`,
  `actor_id`, `hlc`, and `updates` — so it reads no cache and cannot
  depend on the resolution frontier. `EbbServer.Storage.ActionFormat`
  still owns the stored shape; this worker only decides where the work
  runs.

  A raise or throw is caught and reported as a failed job, so one bad
  payload cannot take the pool down with it. A real process death is not
  a result this worker can send; the pool monitors the worker and
  contains it.

  The worker monitors its owner (the pool) and stops when it goes away.
  """

  use GenServer

  alias EbbServer.Storage.ActionFormat

  # The `:encode` ablation stores a structurally valid record without
  # encoding this Action's payload.
  @ablated_payload_etf ActionFormat.encode(
                         ActionFormat.build(%{
                           id: "ablated",
                           actor_id: "ablated",
                           hlc: 0,
                           updates: []
                         })
                       )

  @type action :: %{
          required(:id) => String.t(),
          required(:actor_id) => String.t(),
          required(:hlc) => integer(),
          required(:updates) => [map()]
        }

  @type result :: {:ok, [binary()]} | {:error, term()}

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts)
  end

  @doc """
  Builds and encodes one call's payloads, in input order.

  The reply is `{:prepare_result, ref, result}` on the owner. `result` is
  `{:ok, payload_etfs}` or `{:error, reason}`.
  """
  @spec prepare(GenServer.server(), reference(), [action()]) :: :ok
  def prepare(worker, ref, actions) do
    GenServer.cast(worker, {:prepare, ref, actions})
  end

  @impl true
  def init(opts) do
    owner = Keyword.fetch!(opts, :owner)

    {:ok,
     %{
       owner: owner,
       owner_ref: Process.monitor(owner),
       ablate: Keyword.get(opts, :ablate, []),
       prepare_fn: Keyword.get(opts, :prepare_fn)
     }}
  end

  @impl true
  def handle_cast({:prepare, ref, actions}, state) do
    result =
      try do
        {:ok, Enum.map(actions, &prepare_one(&1, state))}
      rescue
        error -> {:error, {:raised, error, __STACKTRACE__}}
      catch
        kind, value -> {:error, {kind, value}}
      end

    send(state.owner, {:prepare_result, ref, result})
    {:noreply, state}
  end

  @impl true
  def handle_info({:DOWN, owner_ref, :process, _owner, _reason}, %{owner_ref: owner_ref} = state) do
    {:stop, :normal, state}
  end

  def handle_info(_message, state), do: {:noreply, state}

  defp prepare_one(action, %{prepare_fn: fun}) when is_function(fun, 1), do: fun.(action)
  defp prepare_one(action, state), do: default_prepare(action, state.ablate)

  defp default_prepare(action, ablate) do
    payload = if :build in ablate, do: %{}, else: ActionFormat.build(action)
    if :encode in ablate, do: @ablated_payload_etf, else: ActionFormat.encode(payload)
  end
end
