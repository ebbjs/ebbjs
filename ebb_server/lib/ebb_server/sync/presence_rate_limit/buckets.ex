defmodule EbbServer.Sync.PresenceRateLimit.Buckets do
  @moduledoc """
  ETS table of presence token buckets, owned by a small GenServer.

  One row per actor: `{actor_id, milli_tokens, updated_at_ms}`, where
  `milli_tokens` is the remaining budget scaled by 1000 so all arithmetic
  stays integral. `EbbServer.Sync.PresenceRateLimit` reads and writes it
  directly; the owning process only gives the table a lifetime that outlives
  a single connection, and sweeps it.

  ## Sweeping

  A bucket idle for at least the time an empty one needs to refill to the
  burst (`burst / per_second`, floored at a minute) is deleted. That window
  makes the deletion indistinguishable from keeping the row — the actor would
  be at full burst either way — so reclaiming cannot be used to escape the
  limit. Without it the table would grow with every actor that ever sent
  presence. The window is derived from the rate at start-up, so a runtime
  rate change takes effect for new requests but not for the sweep schedule.
  """

  use GenServer

  alias EbbServer.Sync.PresenceRateLimit

  @default_table :ebb_presence_rate_limit_buckets
  @min_idle_ms 60_000
  @default_sweep_interval_ms 30_000

  @typedoc "Tokens are milli-tokens; the timestamp is a monotonic millisecond."
  @type bucket :: {tokens :: non_neg_integer(), updated_at_ms :: integer()}
  @type rate :: {pos_integer(), pos_integer()}

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, opts, name: name)
  end

  @doc "The table the named owner created, falling back to the default name."
  @spec table(atom()) :: atom()
  def table(name \\ __MODULE__), do: :persistent_term.get({name, :table}, @default_table)

  @doc "A bucket with the full budget available at `now_ms`."
  @spec full(rate(), integer()) :: bucket()
  def full({_per_second, burst}, now_ms), do: {burst * 1000, now_ms}

  @doc """
  Refills a bucket up to `now_ms` and spends one token.

  Returns `{:ok, bucket}` with the token spent, or `{:limited, bucket,
  retry_after_ms}` with the bucket refilled but untouched and the wait until
  one token is available.
  """
  @spec take(bucket(), integer(), rate()) ::
          {:ok, bucket()} | {:limited, bucket(), pos_integer()}
  def take({tokens, updated_at}, now_ms, {per_second, burst}) do
    elapsed_ms = max(now_ms - updated_at, 0)
    refilled = min(tokens + elapsed_ms * per_second, burst * 1000)

    if refilled >= 1000 do
      {:ok, {refilled - 1000, now_ms}}
    else
      {:limited, {refilled, now_ms}, ceil_div(1000 - refilled, per_second)}
    end
  end

  @doc """
  Spends one token from the actor's bucket, creating it full on first sight.

  `:ok` admits the request; `{:limited, retry_after_ms}` rejects it. A missing
  table (the owner restarting) admits: the table is an amplifier cap, and
  turning a supervisor restart into a presence outage would be worse than
  admitting a few requests without it.
  """
  @spec consume(String.t(), integer(), rate(), atom()) :: :ok | {:limited, pos_integer()}
  def consume(actor_id, now_ms, rate, table \\ table()) do
    bucket =
      case :ets.lookup(table, actor_id) do
        [{^actor_id, tokens, updated_at}] -> {tokens, updated_at}
        [] -> full(rate, now_ms)
      end

    case take(bucket, now_ms, rate) do
      {:ok, next} ->
        :ets.insert(table, row(actor_id, next))
        :ok

      {:limited, next, retry_after_ms} ->
        :ets.insert(table, row(actor_id, next))
        {:limited, retry_after_ms}
    end
  rescue
    ArgumentError -> :ok
  end

  @doc "Deletes buckets idle for longer than `idle_after_ms` at `now_ms`."
  @spec sweep(integer(), non_neg_integer(), atom()) :: :ok
  def sweep(now_ms, idle_after_ms, table \\ table()) do
    cutoff = now_ms - idle_after_ms
    :ets.select_delete(table, [{{:"$1", :_, :"$2"}, [{:<, :"$2", cutoff}], [true]}])
    :ok
  rescue
    ArgumentError -> :ok
  end

  @doc """
  How long a bucket must sit untouched before deleting it is equivalent to
  keeping it: the time an empty bucket needs to refill to the burst, with a
  floor so a fast rate does not churn the table.
  """
  @spec idle_after_ms(rate()) :: pos_integer()
  def idle_after_ms({per_second, burst}) do
    max(ceil_div(burst * 1000, per_second), @min_idle_ms)
  end

  defp row(actor_id, {tokens, updated_at}), do: {actor_id, tokens, updated_at}

  @doc "Integer division rounded up; shared with the plug's `Retry-After`."
  @spec ceil_div(non_neg_integer(), pos_integer()) :: non_neg_integer()
  def ceil_div(dividend, divisor), do: div(dividend + divisor - 1, divisor)

  @impl true
  def init(opts) do
    name = Keyword.get(opts, :name, __MODULE__)
    table = Keyword.get(opts, :table, @default_table)
    rate = Keyword.get_lazy(opts, :rate, &PresenceRateLimit.rate/0)
    sweep_interval_ms = Keyword.get(opts, :sweep_interval_ms, @default_sweep_interval_ms)
    idle_after_ms = Keyword.get(opts, :idle_after_ms, idle_after_ms(rate))

    if :ets.whereis(table) != :undefined do
      :ets.delete(table)
    end

    :ets.new(table, [:set, :public, :named_table, read_concurrency: true, write_concurrency: true])

    :persistent_term.put({name, :table}, table)

    schedule_sweep(sweep_interval_ms)

    {:ok,
     %{
       name: name,
       table: table,
       sweep_interval_ms: sweep_interval_ms,
       idle_after_ms: idle_after_ms
     }}
  end

  @impl true
  def handle_info(:sweep, state) do
    sweep(now_ms(), state.idle_after_ms, state.table)
    schedule_sweep(state.sweep_interval_ms)
    {:noreply, state}
  end

  defp schedule_sweep(interval_ms), do: Process.send_after(self(), :sweep, interval_ms)

  defp now_ms, do: System.monotonic_time(:millisecond)

  @impl true
  def terminate(_reason, state) do
    :persistent_term.erase({state.name, :table})

    try do
      :ets.delete(state.table)
    rescue
      ArgumentError -> :ok
    end

    :ok
  end
end
