defmodule EbbServer.Sync.PresenceRateLimit.BucketsTest do
  @moduledoc """
  The token bucket is a pure function of `(bucket, now, rate)`; these tests
  pin the arithmetic against worked examples, and pin the ETS-backed store's
  actor keying and idle reclamation.
  """

  use ExUnit.Case, async: true

  alias EbbServer.Sync.PresenceRateLimit
  alias EbbServer.Sync.PresenceRateLimit.Buckets

  describe "call/2" do
    test "passes a presence request with no assigned actor through untouched" do
      conn = Plug.Test.conn(:post, "/sync/presence", "{}")

      assert PresenceRateLimit.call(conn, []) == conn
    end
  end

  describe "rate/0" do
    test "defaults to a rate the client's debounce cannot trip" do
      # 100 ms per-tab debounce => 10 sends/s per tab; two tabs fit inside the
      # sustained rate. Raise this test's expectation with the default, not the
      # other way around.
      assert PresenceRateLimit.rate() == {20, 40}
    end
  end

  describe "take/3" do
    test "admits exactly the burst at one instant, then reports the refill delay" do
      rate = {2, 3}
      now = 1_000
      bucket = Buckets.full(rate, now)

      {results, _bucket} =
        Enum.map_reduce(1..4, bucket, fn _, current ->
          case Buckets.take(current, now, rate) do
            {:ok, next} -> {:ok, next}
            {:limited, next, retry_after_ms} -> {{:limited, retry_after_ms}, next}
          end
        end)

      assert results == [:ok, :ok, :ok, {:limited, 500}]
    end

    test "refills at the sustained rate" do
      rate = {2, 3}
      bucket = drain(Buckets.full(rate, 0), 0, rate, 3)

      # Half a token after 250 ms: still limited, but only for the rest.
      assert {:limited, bucket, 250} = Buckets.take(bucket, 250, rate)

      # A full token after 500 ms.
      assert {:ok, bucket} = Buckets.take(bucket, 500, rate)

      # The refill from the previous call counted: nothing more yet.
      assert {:limited, _bucket, 500} = Buckets.take(bucket, 500, rate)
    end

    test "caps the refill at the burst" do
      rate = {2, 3}
      bucket = drain(Buckets.full(rate, 0), 0, rate, 3)

      # An hour of idle time refills to the burst, not beyond it.
      hour_ms = 60 * 60 * 1000

      {results, _bucket} =
        Enum.map_reduce(1..4, bucket, fn _, current ->
          case Buckets.take(current, hour_ms, rate) do
            {:ok, next} -> {:ok, next}
            {:limited, next, retry_after_ms} -> {{:limited, retry_after_ms}, next}
          end
        end)

      assert results == [:ok, :ok, :ok, {:limited, 500}]
    end
  end

  describe "consume/4" do
    test "two requests from one actor share a bucket; another actor has its own" do
      table = start_store()
      rate = {1, 1}

      assert :ok = Buckets.consume("actor_a", 0, rate, table)
      assert {:limited, _retry_after_ms} = Buckets.consume("actor_a", 0, rate, table)
      assert :ok = Buckets.consume("actor_b", 0, rate, table)
    end

    test "an over-limit actor's bucket still refills" do
      table = start_store()
      rate = {1, 1}

      assert :ok = Buckets.consume("actor_a", 0, rate, table)
      assert {:limited, 1_000} = Buckets.consume("actor_a", 0, rate, table)
      assert :ok = Buckets.consume("actor_a", 1_000, rate, table)
    end
  end

  describe "sweeping" do
    test "reclaims buckets idle for longer than the refill window" do
      table = start_store(idle_after_ms: 20, sweep_interval_ms: 5)
      now = System.monotonic_time(:millisecond)

      assert :ok = Buckets.consume("actor_a", now, {1, 1}, table)
      assert [_] = :ets.lookup(table, "actor_a")

      assert eventually(fn -> :ets.lookup(table, "actor_a") == [] end)
    end

    test "keeps a bucket that is still within the idle window" do
      table = start_store(idle_after_ms: 60_000, sweep_interval_ms: 5)
      now = System.monotonic_time(:millisecond)

      assert :ok = Buckets.consume("actor_a", now, {1, 1}, table)

      :ok = Buckets.sweep(now + 100, 60_000, table)

      assert [_] = :ets.lookup(table, "actor_a")
    end
  end

  describe "idle_after_ms/1" do
    test "is the time an empty bucket needs to refill, with a floor" do
      assert Buckets.idle_after_ms({1, 1}) == 60_000
      assert Buckets.idle_after_ms({100, 1}) == 60_000
      assert Buckets.idle_after_ms({1, 120}) == 120_000
    end
  end

  defp start_store(opts \\ []) do
    table = :"presence_buckets_#{System.unique_integer([:positive])}"
    start_supervised!({Buckets, Keyword.merge([name: table, table: table], opts)})
    table
  end

  defp drain(bucket, now, rate, count) do
    Enum.reduce(1..count, bucket, fn _, current ->
      {:ok, next} = Buckets.take(current, now, rate)
      next
    end)
  end

  defp eventually(fun, attempts \\ 100) do
    cond do
      fun.() ->
        true

      attempts == 0 ->
        false

      true ->
        Process.sleep(10)
        eventually(fun, attempts - 1)
    end
  end
end
