defmodule EbbServer.Storage.CommitterTest do
  @moduledoc """
  Boundary tests for the Committer (ebbjs/ebbjs#531).

  The Committer owns the half of the flush that only needs immutable
  input: wrapper encoding, `cf_*` op assembly, and the durable
  `write_batch`. These tests pin the ops it builds for a
  `PreparedAction` batch, the shape of the result it reports to the
  sequencer, and the `commit_latency_ms` sample that prices the seam.
  """

  use ExUnit.Case, async: false

  alias EbbServer.Storage.{ActionFormat, Committer, PreparedAction, RocksDB}

  import EbbServer.TestHelpers

  setup do
    %{name: rocks_name} = start_rocks()
    %{rocks_name: rocks_name}
  end

  describe "op assembly" do
    test "builds one batch in source order: log, dedup, group index, entity index, type index",
         ctx do
      test_pid = self()
      ref = make_ref()

      action_1 =
        prepared_action("act_1", [update("upd_1", "todo_1")],
          update_scopes: [["g_1", "g_2"]],
          groups: ["g_1", "g_2"]
        )

      action_2 =
        prepared_action("act_2", [update("upd_2", "todo_2"), update("upd_3", "todo_3")],
          update_scopes: [["g_2"], ["g_2"]],
          groups: ["g_2"]
        )

      committer =
        start_committer(ctx, fn ops, opts ->
          send(test_pid, {:ops, ops, opts})
          :ok
        end)

      :ok = Committer.commit(committer, ref, [action_1, action_2], 5, 6)

      assert_receive {:ops, ops, opts}
      assert opts == [name: ctx.rocks_name]
      assert_receive {:committer_result, ^ref, :ok}

      cf_actions = RocksDB.cf_actions(ctx.rocks_name)
      cf_dedup = RocksDB.cf_action_dedup(ctx.rocks_name)
      cf_group = RocksDB.cf_group_actions(ctx.rocks_name)
      cf_entity = RocksDB.cf_entity_actions(ctx.rocks_name)
      cf_type = RocksDB.cf_type_entities(ctx.rocks_name)

      assert [{:put, ^cf_actions, gsn_5, etf_1}, {:put, ^cf_dedup, "act_1", dedup_5} | rest] = ops
      assert gsn_5 == RocksDB.encode_gsn_key(5)
      assert dedup_5 == RocksDB.encode_gsn_key(5)

      assert [
               {:put, ^cf_group, g_1_5, "act_1"},
               {:put, ^cf_group, g_2_5, "act_1"},
               {:put, ^cf_entity, todo_1_5, "act_1"},
               {:put, ^cf_actions, gsn_6, etf_2},
               {:put, ^cf_dedup, "act_2", dedup_6},
               {:put, ^cf_group, g_2_6, "act_2"},
               {:put, ^cf_entity, todo_2_6, "act_2"},
               {:put, ^cf_entity, todo_3_6, "act_2"}
               | type_ops
             ] = rest

      assert g_1_5 == RocksDB.encode_group_action_key("g_1", 5)
      assert g_2_5 == RocksDB.encode_group_action_key("g_2", 5)
      assert g_2_6 == RocksDB.encode_group_action_key("g_2", 6)
      assert todo_1_5 == RocksDB.encode_entity_gsn_key("todo_1", 5)
      assert todo_2_6 == RocksDB.encode_entity_gsn_key("todo_2", 6)
      assert todo_3_6 == RocksDB.encode_entity_gsn_key("todo_3", 6)
      assert gsn_6 == RocksDB.encode_gsn_key(6)
      assert dedup_6 == RocksDB.encode_gsn_key(6)

      # The type keys are flush-scoped (no GSN component): one put each,
      # sorted, appended after the per-Action ops.
      assert type_ops ==
               [
                 "todo_1",
                 "todo_2",
                 "todo_3"
               ]
               |> Enum.map(&RocksDB.encode_type_entity_key("todo", &1))
               |> Enum.sort()
               |> Enum.map(fn key -> {:put, cf_type, key, <<>>} end)

      assert stored_action(etf_1, 5) == %{
               "id" => "act_1",
               "actor_id" => "a_committer",
               "hlc" => 1,
               "gsn" => 5,
               "update_scopes" => [["g_1", "g_2"]],
               "updates" => [
                 %{
                   "id" => "upd_1",
                   "subject_id" => "todo_1",
                   "subject_type" => "todo",
                   "method" => "put",
                   "data" => %{"fields" => %{}}
                 }
               ]
             }

      assert stored_action(etf_2, 6)["update_scopes"] == [["g_2"], ["g_2"]]
    end

    test "stores the supplied payload_etf verbatim instead of rebuilding the Action", ctx do
      test_pid = self()
      ref = make_ref()

      # The prebuilt payload describes a different Action than the boundary
      # struct's identity fields, so only the payload can explain what lands
      # in `cf_actions`.
      prebuilt = %{
        id: "act_prebuilt",
        actor_id: "a_prebuilt",
        hlc: 99,
        updates: [update("upd_prebuilt", "todo_prebuilt")]
      }

      payload_etf = prebuilt |> ActionFormat.build() |> ActionFormat.encode()

      action =
        prepared_action("act_boundary", [update("upd_boundary", "todo_boundary")],
          payload_etf: payload_etf,
          update_scopes: [["g_prebuilt"]]
        )

      committer =
        start_committer(ctx, fn ops, _opts ->
          send(test_pid, {:ops, ops})
          :ok
        end)

      :ok = Committer.commit(committer, ref, [action], 7, 7)

      assert_receive {:ops, ops}
      assert_receive {:committer_result, ^ref, :ok}

      {:put, _cf_actions, _key, value} =
        Enum.find(ops, fn
          {:put, cf, _key, _value} -> cf == RocksDB.cf_actions(ctx.rocks_name)
          _other -> false
        end)

      stored = ActionFormat.decode(value, 7)

      assert stored["id"] == "act_prebuilt"
      assert stored["actor_id"] == "a_prebuilt"
      assert stored["hlc"] == 99
      assert stored["gsn"] == 7
      assert stored["update_scopes"] == [["g_prebuilt"]]
      assert [%{"id" => "upd_prebuilt", "subject_id" => "todo_prebuilt"}] = stored["updates"]
    end

    test "writes one cf_type_entities put per unique key across the batch", ctx do
      test_pid = self()
      ref = make_ref()

      shared = [update("upd_a", "todo_shared"), update("upd_b", "todo_shared")]

      committer =
        start_committer(ctx, fn ops, _opts ->
          send(test_pid, {:ops, ops})
          :ok
        end)

      :ok =
        Committer.commit(
          committer,
          ref,
          [
            prepared_action("act_a", shared),
            prepared_action("act_b", [update("upd_c", "todo_shared")])
          ],
          1,
          2
        )

      assert_receive {:ops, ops}
      assert_receive {:committer_result, ^ref, :ok}

      type_puts =
        for {:put, cf, _key, <<>>} <- ops, cf == RocksDB.cf_type_entities(ctx.rocks_name), do: :ok

      assert length(type_puts) == 1
    end

    test "ablations drop only their own ops", ctx do
      test_pid = self()
      ref = make_ref()

      committer =
        start_committer(
          ctx,
          fn ops, _opts ->
            send(test_pid, {:ops, ops})
            :ok
          end,
          ablate: [:dedup, :group_index, :entity_index]
        )

      action =
        prepared_action("act_ablated", [update("upd_ablated", "todo_ablated")],
          update_scopes: [["g_ablated"]],
          groups: ["g_ablated"]
        )

      :ok = Committer.commit(committer, ref, [action], 1, 1)

      assert_receive {:ops, ops}
      assert_receive {:committer_result, ^ref, :ok}

      assert [{:put, cf, _key, _etf}] = ops
      assert cf == RocksDB.cf_actions(ctx.rocks_name)
    end
  end

  describe "result reporting" do
    test "reports a failed commit to the sequencer", ctx do
      ref = make_ref()

      committer =
        start_committer(ctx, fn _ops, _opts -> {:error, :injected_rocksdb_failure} end)

      :ok =
        Committer.commit(
          committer,
          ref,
          [prepared_action("act_fail", [update("upd", "todo")])],
          1,
          1
        )

      assert_receive {:committer_result, ^ref, {:error, :injected_rocksdb_failure}}
    end

    test "reports a raise instead of crashing, and keeps serving", ctx do
      ref = make_ref()
      next_ref = make_ref()

      committer =
        start_committer(ctx, fn _ops, _opts ->
          raise "commit boom"
        end)

      :ok =
        Committer.commit(
          committer,
          ref,
          [prepared_action("act_raise", [update("upd", "todo")])],
          1,
          1
        )

      assert_receive {:committer_result, ^ref,
                      {:raised, :error, %RuntimeError{message: "commit boom"}, stacktrace}}

      assert is_list(stacktrace)

      :ok =
        Committer.commit(
          committer,
          next_ref,
          [prepared_action("act_raise_again", [update("upd_again", "todo_again")])],
          2,
          2
        )

      assert_receive {:committer_result, ^next_ref, {:raised, :error, %RuntimeError{}, _}}
    end

    test "reports a raise while building ops", ctx do
      ref = make_ref()
      committer = start_committer(ctx, fn _ops, _opts -> :ok end)

      # A non-list group set makes op assembly raise, so the failure lands
      # on the assembly side of the boundary rather than in `commit_fn`.
      broken =
        prepared_action("act_broken", [update("upd_broken", "todo_broken")], groups: :not_a_list)

      :ok = Committer.commit(committer, ref, [broken], 1, 1)

      assert_receive {:committer_result, ^ref,
                      {:raised, :error, %Protocol.UndefinedError{}, _stacktrace}}

      assert Process.alive?(committer)
    end
  end

  describe "commit_latency_ms" do
    test "is emitted for a successful commit", ctx do
      ref = attach_telemetry([[:ebb, :writer, :commit_latency_ms]])
      committed = make_ref()

      committer = start_committer(ctx, fn ops, opts -> RocksDB.write_batch(ops, opts) end)

      :ok =
        Committer.commit(
          committer,
          committed,
          [prepared_action("act_latency", [update("upd_latency", "todo_latency")])],
          3,
          3
        )

      assert_receive {:committer_result, ^committed, :ok}

      assert [{[:ebb, :writer, :commit_latency_ms], %{duration: duration}, metadata}] =
               telemetry_events(ref)

      assert is_integer(duration)
      assert metadata == %{gsn_start: 3, gsn_end: 3}
    end

    test "is emitted for a failed commit", ctx do
      ref = attach_telemetry([[:ebb, :writer, :commit_latency_ms]])
      committed = make_ref()

      committer =
        start_committer(ctx, fn _ops, _opts -> {:error, :injected_rocksdb_failure} end)

      :ok =
        Committer.commit(
          committer,
          committed,
          [
            prepared_action("act_latency_fail", [update("upd_latency_fail", "todo_latency_fail")])
          ],
          4,
          4
        )

      assert_receive {:committer_result, ^committed, {:error, :injected_rocksdb_failure}}

      assert [{[:ebb, :writer, :commit_latency_ms], %{duration: duration}, metadata}] =
               telemetry_events(ref)

      assert is_integer(duration)
      assert metadata == %{gsn_start: 4, gsn_end: 4}
    end
  end

  describe "lifecycle" do
    test "stops when its sequencer is gone" do
      owner = spawn(fn -> receive do: (:stop -> :ok) end)

      {:ok, committer} =
        Committer.start_link(
          owner: owner,
          rocks_name: :unused_rocks_name,
          commit_fn: fn _ops, _opts -> :ok end
        )

      ref = Process.monitor(committer)
      send(owner, :stop)

      assert_receive {:DOWN, ^ref, :process, ^committer, :normal}, 2_000
    end
  end

  defp start_committer(ctx, commit_fn, extra \\ []) do
    {:ok, pid} =
      Committer.start_link(
        Keyword.merge(
          [owner: self(), rocks_name: ctx.rocks_name, commit_fn: commit_fn],
          extra
        )
      )

    on_exit(fn -> safe_stop(pid) end)

    pid
  end

  defp prepared_action(id, updates, opts \\ []) do
    action = %{id: id, actor_id: "a_committer", hlc: 1, updates: updates}

    %PreparedAction{
      id: id,
      actor_id: action.actor_id,
      hlc: action.hlc,
      updates: updates,
      payload_etf:
        Keyword.get_lazy(opts, :payload_etf, fn ->
          action |> ActionFormat.build() |> ActionFormat.encode()
        end),
      update_scopes: Keyword.get(opts, :update_scopes, Enum.map(updates, fn _update -> [] end)),
      groups: Keyword.get(opts, :groups, []),
      type_entity_keys:
        Keyword.get(opts, :type_entity_keys, Enum.map(updates, &type_entity_key/1)),
      affected_entities:
        Keyword.get(opts, :affected_entities, Enum.map(updates, &affected_entity/1))
    }
  end

  defp update(id, subject_id, opts \\ []) do
    %{
      id: id,
      subject_id: subject_id,
      subject_type: Keyword.get(opts, :subject_type, "todo"),
      method: Keyword.get(opts, :method, :put),
      data: Keyword.get(opts, :data, %{"fields" => %{}})
    }
  end

  defp type_entity_key(update) do
    RocksDB.encode_type_entity_key(update.subject_type, update.subject_id)
  end

  defp affected_entity(update), do: {update.subject_id, update.subject_type}

  defp stored_action(etf, gsn), do: ActionFormat.decode(etf, gsn)
end
