defmodule EbbServer.Storage.WriterOverlayChainTest do
  @moduledoc """
  Cross-flush cache-overlay chaining in the Writer (ebbjs/ebbjs#533).

  A successor batch resolves its group scopes against the predecessor's
  planned cache rows while that predecessor is still committing. A
  predecessor that moves membership holds the successor at the commit gate;
  if it abandons, the successor is rebuilt from the surviving cache instead
  of letting stale scopes reach the log.
  """

  use ExUnit.Case, async: false

  alias EbbServer.Storage.{ActionLog, EntityGroupCache, Writer}

  import EbbServer.TestHelpers

  setup do
    cache = start_isolated_cache()
    %{name: rocks_name} = start_rocks()

    Map.put(cache, :rocks_name, rocks_name)
  end

  describe "a successor resolves against an unapplied predecessor" do
    test "the membership row moves the entity into the group before N applies", ctx do
      test_pid = self()
      commit_fn = first_blocking_commit(test_pid)

      %{name: writer_name} =
        start_writer(
          writer_opts(ctx, %{
            max_in_flight: 2,
            committer_pool_size: 2,
            batch_max_size: 1,
            commit_fn: commit_fn
          })
        )

      first = validated_action(%{id: "act_overlay_first", updates: [membership_put()]})
      second = validated_action(%{id: "act_overlay_second", updates: [todo_update()]})

      first_task = Task.async(fn -> Writer.write_actions([first], writer_name) end)
      assert_receive {:commit_started, first_worker, :first}, 2_000

      second_task = Task.async(fn -> Writer.write_actions([second], writer_name) end)

      assert wait_until(fn ->
               state = :sys.get_state(writer_name)

               Enum.any?(state.pipeline.batches, fn {_ref, batch} ->
                 batch.phase == :prepared and batch.groups_by_gsn[2] == ["group_chain"]
               end)
             end)

      refute_receive {:commit_started, _worker, :later}, 100

      send(first_worker, {:release, :ok})
      assert {:ok, {1, 1}, []} = Task.await(first_task, 2_000)
      assert_receive {:commit_started, _worker, :later}, 2_000
      assert {:ok, {2, 2}, []} = Task.await(second_task, 2_000)

      assert [%{"update_scopes" => [["group_chain"]]}] =
               ActionLog.read(2, 2, rocks_name: ctx.rocks_name)
    end
  end

  describe "a predecessor moves a cached membership" do
    test "the successor resolves the moved group before N applies", ctx do
      seed_membership(ctx, "group_old")

      test_pid = self()
      commit_fn = first_blocking_commit(test_pid)

      %{name: writer_name} =
        start_writer(
          writer_opts(ctx, %{
            max_in_flight: 2,
            committer_pool_size: 2,
            batch_max_size: 1,
            commit_fn: commit_fn
          })
        )

      first =
        validated_action(%{
          id: "act_overlay_move",
          updates: [membership_patch("group_new")]
        })

      second = validated_action(%{id: "act_overlay_after_move", updates: [todo_update()]})

      first_task = Task.async(fn -> Writer.write_actions([first], writer_name) end)
      assert_receive {:commit_started, first_worker, :first}, 2_000

      second_task = Task.async(fn -> Writer.write_actions([second], writer_name) end)

      assert wait_until(fn ->
               state = :sys.get_state(writer_name)

               Enum.any?(state.pipeline.batches, fn {_ref, batch} ->
                 batch.phase == :prepared and batch.groups_by_gsn[2] == ["group_new"]
               end)
             end)

      send(first_worker, {:release, :ok})
      assert {:ok, {1, 1}, []} = Task.await(first_task, 2_000)
      assert {:ok, {2, 2}, []} = Task.await(second_task, 2_000)

      assert [%{"update_scopes" => [["group_new"]]}] =
               ActionLog.read(2, 2, rocks_name: ctx.rocks_name)
    end
  end

  describe "a predecessor deletes a cached membership" do
    test "the successor does not resurrect the removed group", ctx do
      seed_membership(ctx, "group_old")

      test_pid = self()
      commit_fn = first_blocking_commit(test_pid)

      %{name: writer_name} =
        start_writer(
          writer_opts(ctx, %{
            max_in_flight: 2,
            committer_pool_size: 2,
            batch_max_size: 1,
            commit_fn: commit_fn
          })
        )

      first =
        validated_action(%{
          id: "act_overlay_delete",
          updates: [validated_update(delete_opts())]
        })

      second = validated_action(%{id: "act_overlay_after_delete", updates: [todo_update()]})

      first_task = Task.async(fn -> Writer.write_actions([first], writer_name) end)
      assert_receive {:commit_started, first_worker, :first}, 2_000

      second_task = Task.async(fn -> Writer.write_actions([second], writer_name) end)

      assert wait_until(fn ->
               state = :sys.get_state(writer_name)

               Enum.any?(state.pipeline.batches, fn {_ref, batch} ->
                 batch.phase == :prepared and batch.groups_by_gsn[2] == []
               end)
             end)

      send(first_worker, {:release, :ok})
      assert {:ok, {1, 1}, []} = Task.await(first_task, 2_000)
      assert {:ok, {2, 2}, []} = Task.await(second_task, 2_000)

      assert [%{"update_scopes" => [[]]}] =
               ActionLog.read(2, 2, rocks_name: ctx.rocks_name)
    end
  end

  describe "an abandoned predecessor rebuilds the chain" do
    test "the successor commits with scopes from the cache, not the failed slice", ctx do
      test_pid = self()
      commit_fn = first_blocking_commit(test_pid)

      %{name: writer_name} =
        start_writer(
          writer_opts(ctx, %{
            max_in_flight: 2,
            committer_pool_size: 2,
            batch_max_size: 1,
            commit_fn: commit_fn
          })
        )

      first = validated_action(%{id: "act_overlay_fail", updates: [membership_put()]})
      second = validated_action(%{id: "act_overlay_rebuilt", updates: [todo_update()]})

      first_task = Task.async(fn -> Writer.write_actions([first], writer_name) end)
      assert_receive {:commit_started, first_worker, :first}, 2_000

      second_task = Task.async(fn -> Writer.write_actions([second], writer_name) end)

      assert wait_until(fn ->
               state = :sys.get_state(writer_name)

               Enum.any?(state.pipeline.batches, fn {_ref, batch} ->
                 batch.phase == :prepared and batch.groups_by_gsn[2] == ["group_chain"]
               end)
             end)

      send(first_worker, {:release, :error})

      assert {:error, {:rocksdb_write_failed, :injected}} = Task.await(first_task, 2_000)
      assert {:ok, {2, 2}, []} = Task.await(second_task, 2_000)

      assert [%{"update_scopes" => [[]]}] =
               ActionLog.read(2, 2, rocks_name: ctx.rocks_name)
    end
  end

  # The Committer blocks the first range until the test releases it; every
  # later commit runs immediately. `outcome` decides whether the first
  # durable write succeeds or abandons.
  defp first_blocking_commit(test_pid) do
    attempts = :atomics.new(1, signed: false)

    fn ops, opts ->
      if :atomics.add_get(attempts, 1, 1) == 1 do
        send(test_pid, {:commit_started, self(), :first})

        receive do
          {:release, :ok} -> EbbServer.Storage.RocksDB.write_batch(ops, opts)
          {:release, :error} -> {:error, :injected}
        end
      else
        send(test_pid, {:commit_started, self(), :later})
        EbbServer.Storage.RocksDB.write_batch(ops, opts)
      end
    end
  end

  defp seed_membership(ctx, group_id) do
    :ok =
      EntityGroupCache.put_entity_group(
        %{id: "eg_chain", entity_id: "todo_chain", group_id: group_id},
        entity_groups: ctx.entity_groups,
        entity_groups_by_id: ctx.entity_groups_by_id,
        entity_groups_by_group: ctx.entity_groups_by_group
      )
  end

  defp membership_patch(group_id) do
    validated_update(%{
      id: "eg_chain",
      subject_id: "eg_chain",
      subject_type: "entityGroup",
      method: :patch,
      data: %{"fields" => %{"group_id" => %{"value" => group_id}}}
    })
  end

  defp delete_opts do
    %{
      id: "eg_chain",
      subject_id: "eg_chain",
      subject_type: "entityGroup",
      method: :delete
    }
  end

  defp membership_put do
    validated_update(%{
      id: "eg_chain",
      subject_id: "eg_chain",
      subject_type: "entityGroup",
      data: %{
        "fields" => %{
          "entity_id" => %{"value" => "todo_chain"},
          "group_id" => %{"value" => "group_chain"}
        }
      }
    })
  end

  defp todo_update do
    validated_update(%{subject_id: "todo_chain", subject_type: "todo"})
  end
end
