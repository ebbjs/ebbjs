defmodule EbbServer.Sync.FanOutRouterShardingTest do
  @moduledoc """
  Pins the `:fanout_group_shards` fan-out: a group's subscribers are spread
  across K `GroupServer` processes and a committed batch still reaches each
  subscriber exactly once.
  """

  use ExUnit.Case, async: false
  use EbbServer.Integration.StorageCase

  import EbbServer.TestHelpers

  alias EbbServer.Integration.ActionHelpers
  alias EbbServer.Sync.FanOutRouter

  @registry EbbServer.Sync.GroupRegistry

  setup do
    original = Application.get_env(:ebb_server, :fanout_group_shards, 1)
    Application.put_env(:ebb_server, :fanout_group_shards, 2)

    on_exit(fn -> Application.put_env(:ebb_server, :fanout_group_shards, original) end)

    group_id = "g_shard_#{:erlang.unique_integer([:positive])}"
    actor_id = "a_shard_#{:erlang.unique_integer([:positive])}"

    {:ok, group_id: group_id, actor_id: actor_id}
  end

  describe "with two shards" do
    test "subscribing a group's connections registers one GroupServer per shard", %{
      group_id: group_id,
      actor_id: actor_id
    } do
      pids = connections_covering(group_id, 2)

      for pid <- pids, do: :ok = FanOutRouter.subscribe([group_id], pid, actor_id)

      for shard <- [0, 1] do
        assert eventually(fn -> registered?(group_id, shard) end),
               "expected a GroupServer registered for {#{group_id}, #{shard}}"
      end

      # Every connection is recorded against exactly one shard.
      entries = :sys.get_state(FanOutRouter).subscriptions
      for pid <- pids, do: assert([{^group_id, _shard}] = Map.fetch!(entries, pid))

      for pid <- pids, do: :ok = FanOutRouter.unsubscribe(pid)
    end

    test "a committed batch is delivered exactly once to every subscriber", %{
      group_id: group_id,
      actor_id: actor_id
    } do
      assert ActionHelpers.bootstrap_group(actor_id, group_id, ["todo.*", "entityGroup.*"]).status ==
               200

      test = self()
      collectors = collectors_covering(group_id, 2, test)
      for pid <- collectors, do: :ok = FanOutRouter.subscribe([group_id], pid, actor_id)

      action_id = "act_shard_#{:erlang.unique_integer([:positive])}"
      entity_id = "todo_shard_#{:erlang.unique_integer([:positive])}"
      hlc = generate_hlc()

      action = %{
        "id" => action_id,
        "actor_id" => actor_id,
        "hlc" => hlc,
        "updates" => [
          todo_update(entity_id, hlc),
          ActionHelpers.entity_group_update(entity_id, group_id, hlc)
        ]
      }

      conn =
        ActionHelpers.post_actions(
          ActionHelpers.msgpack_encode!(%{"actions" => [action]}),
          actor_id
        )

      assert conn.status == 200

      for pid <- collectors do
        bytes = await_push(pid)
        assert bytes =~ action_id
        refute_receive {:pushed, ^pid, _}, 200
      end

      for pid <- collectors, do: :ok = FanOutRouter.unsubscribe(pid)
    end

    test "unsubscribe removes each connection from its own shard", %{
      group_id: group_id,
      actor_id: actor_id
    } do
      %{0 => pid0, 1 => pid1} = one_per_shard(group_id, 2)

      :ok = FanOutRouter.subscribe([group_id], pid0, actor_id)
      :ok = FanOutRouter.subscribe([group_id], pid1, actor_id)
      assert eventually(fn -> registered?(group_id, 0) and registered?(group_id, 1) end)

      :ok = FanOutRouter.unsubscribe(pid0)

      assert eventually(fn -> not registered?(group_id, 0) end),
             "shard 0 should have no GroupServer after its only subscriber left"

      assert registered?(group_id, 1),
             "shard 1 must keep its GroupServer while pid1 stays subscribed"

      :ok = FanOutRouter.unsubscribe(pid1)

      assert eventually(fn -> not registered?(group_id, 1) end)
    end
  end

  defp registered?(group_id, shard) do
    Registry.lookup(@registry, {group_id, shard}) != []
  end

  defp todo_update(entity_id, hlc) do
    %{
      "id" => "upd_shard_#{:erlang.unique_integer([:positive])}",
      "subject_id" => entity_id,
      "subject_type" => "todo",
      "method" => "put",
      "data" => %{"fields" => %{"title" => %{"type" => "lww", "value" => "x", "hlc" => hlc}}}
    }
  end

  # Spawns connection processes until every shard has one, keeping only the
  # first pid seen on each shard and killing the rest.
  defp one_per_shard(group_id, shards) do
    Enum.reduce_while(1..10_000, %{}, fn _, found ->
      pid = spawn(fn -> receive do: (:stop -> :ok) end)
      shard = :erlang.phash2({pid, group_id}, shards)

      if Map.has_key?(found, shard) do
        Process.exit(pid, :kill)
        {:cont, found}
      else
        found = Map.put(found, shard, pid)
        if map_size(found) == shards, do: {:halt, found}, else: {:cont, found}
      end
    end)
  end

  defp connections_covering(group_id, shards) do
    Enum.reduce_while(1..10_000, {%{}, []}, fn _, {found, pids} ->
      pid = spawn(fn -> receive do: (:stop -> :ok) end)
      pids = [pid | pids]
      found = Map.put_new(found, :erlang.phash2({pid, group_id}, shards), pid)

      if map_size(found) == shards, do: {:halt, {found, pids}}, else: {:cont, {found, pids}}
    end)
    |> elem(1)
  end

  defp collectors_covering(group_id, shards, test) do
    Enum.reduce_while(1..10_000, {%{}, []}, fn _, {found, pids} ->
      pid = start_collector(test)
      pids = [pid | pids]
      found = Map.put_new(found, :erlang.phash2({pid, group_id}, shards), pid)

      if map_size(found) == shards, do: {:halt, {found, pids}}, else: {:cont, {found, pids}}
    end)
    |> elem(1)
  end

  defp start_collector(test) do
    spawn(fn -> collect(test) end)
  end

  defp collect(test) do
    receive do
      {:"$gen_cast", {:push_data, bytes}} ->
        send(test, {:pushed, self(), bytes})
        collect(test)

      _other ->
        collect(test)
    end
  end

  defp await_push(pid) do
    receive do
      {:pushed, ^pid, bytes} -> bytes
    after
      5_000 -> flunk("timed out waiting for a push to #{inspect(pid)}")
    end
  end

  defp eventually(fun, attempts \\ 100)
  defp eventually(fun, 0), do: fun.()

  defp eventually(fun, attempts) do
    if fun.() do
      true
    else
      Process.sleep(10)
      eventually(fun, attempts - 1)
    end
  end
end
