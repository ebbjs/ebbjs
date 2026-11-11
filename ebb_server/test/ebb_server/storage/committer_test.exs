defmodule EbbServer.Storage.CommitterTest do
  @moduledoc """
  Boundary tests for the Committer (ebbjs/ebbjs#531).

  The Committer owns the half of the flush that only needs immutable
  input: frame encoding, `cf_*` op assembly, and the durable
  `write_batch`. These tests pin the ops it builds for a
  `PreparedAction` batch, the shape of the result it reports to the
  sequencer, and the `commit_latency_ms` sample that prices the seam.
  """

  use ExUnit.Case, async: false

  alias EbbServer.Storage.{
    ActionFormat,
    Committer,
    ComponentEntityIndex,
    PreparedAction,
    RocksDB
  }

  import EbbServer.TestHelpers

  setup do
    %{name: rocks_name} = start_rocks()
    %{rocks_name: rocks_name}
  end

  describe "op assembly" do
    test "builds one batch in source order: log, dedup, group index, entity index, component index",
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
      cf_component = RocksDB.cf_component_entities(ctx.rocks_name)

      assert [
               {:put, ^cf_actions, gsn_5, etf_1},
               {:put, ^cf_dedup, "act_1", dedup_5},
               {:put, ^cf_group, g_1_5, "act_1"},
               {:put, ^cf_group, g_2_5, "act_1"},
               {:put, ^cf_actions, gsn_6, etf_2},
               {:put, ^cf_dedup, "act_2", dedup_6},
               {:put, ^cf_group, g_2_6, "act_2"}
               | flush_ops
             ] = ops

      assert g_1_5 == RocksDB.encode_group_action_key("g_1", 5)
      assert g_2_5 == RocksDB.encode_group_action_key("g_2", 5)
      assert g_2_6 == RocksDB.encode_group_action_key("g_2", 6)
      assert gsn_5 == RocksDB.encode_gsn_key(5)
      assert gsn_6 == RocksDB.encode_gsn_key(6)
      assert dedup_5 == RocksDB.encode_gsn_key(5)
      assert dedup_6 == RocksDB.encode_gsn_key(6)

      # The entity and component-entity keys are flush-scoped (no per-Action
      # grouping): one coalesced entity row per subject, then one sorted op
      # per distinct key, both appended after the per-Action ops.
      entity_ops = for {:put, ^cf_entity, _key, _value} = op <- flush_ops, do: op

      assert entity_ops == [
               {:put, cf_entity, RocksDB.encode_entity_flush_key("todo_1", 5),
                RocksDB.encode_gsn_list([5])},
               {:put, cf_entity, RocksDB.encode_entity_flush_key("todo_2", 6),
                RocksDB.encode_gsn_list([6])},
               {:put, cf_entity, RocksDB.encode_entity_flush_key("todo_3", 6),
                RocksDB.encode_gsn_list([6])}
             ]

      component_ops = for {_op, ^cf_component, _key, _value} = op <- flush_ops, do: op

      expected_keys =
        [
          {"todo", "todo_1"},
          {"todo/title", "todo_1"},
          {"todo", "todo_2"},
          {"todo/title", "todo_2"},
          {"todo", "todo_3"},
          {"todo/title", "todo_3"}
        ]
        |> Enum.map(fn {name, id} -> RocksDB.encode_component_entity_key(name, id) end)
        |> Enum.sort()
        |> Enum.map(fn key -> {:put, cf_component, key, <<>>} end)

      assert component_ops == expected_keys
      assert flush_ops == entity_ops ++ component_ops

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
                   "component" => "todo/title",
                   "method" => "replace",
                   "data" => %{"value" => "x"}
                 }
               ]
             }

      assert stored_action(etf_2, 6)["update_scopes"] == [["g_2"], ["g_2"]]
    end

    test "writes one cf_entity_actions row per subject in a flush", ctx do
      test_pid = self()
      ref = make_ref()

      action =
        prepared_action("act_two_subjects", [
          update("upd_a", "todo_a"),
          update("upd_b", "todo_b")
        ])

      committer =
        start_committer(ctx, fn ops, _opts ->
          send(test_pid, {:ops, ops})
          :ok
        end)

      :ok = Committer.commit(committer, ref, [action], 9, 9)

      assert_receive {:ops, ops}
      assert_receive {:committer_result, ^ref, :ok}

      assert entity_rows(ops, ctx.rocks_name) == [
               {"todo_a", 9, [9]},
               {"todo_b", 9, [9]}
             ]
    end

    test "coalesces one subject across Actions in a flush into one row", ctx do
      test_pid = self()
      ref = make_ref()

      action_1 =
        prepared_action("act_1", [update("upd_1", "todo_shared")])

      action_2 =
        prepared_action("act_2", [
          update("upd_2", "todo_shared"),
          update("upd_3", "todo_shared")
        ])

      committer =
        start_committer(ctx, fn ops, _opts ->
          send(test_pid, {:ops, ops})
          :ok
        end)

      :ok = Committer.commit(committer, ref, [action_1, action_2], 10, 11)

      assert_receive {:ops, ops}
      assert_receive {:committer_result, ^ref, :ok}

      # The repeated update at GSN 11 is one GSN, not two, and the row's key
      # is the subject's highest GSN in the flush.
      assert entity_rows(ops, ctx.rocks_name) == [{"todo_shared", 11, [10, 11]}]
    end

    test "keys each subject by its own last GSN, not the flush maximum", ctx do
      test_pid = self()
      ref = make_ref()

      action_1 =
        prepared_action("act_1", [
          update("upd_1a", "todo_a"),
          update("upd_1b", "todo_b")
        ])

      action_2 = prepared_action("act_2", [update("upd_2", "todo_a")])

      committer =
        start_committer(ctx, fn ops, _opts ->
          send(test_pid, {:ops, ops})
          :ok
        end)

      :ok = Committer.commit(committer, ref, [action_1, action_2], 1, 2)

      assert_receive {:ops, ops}
      assert_receive {:committer_result, ^ref, :ok}

      # `todo_a` appears in both Actions, so its row is keyed at 2; `todo_b`
      # only appears in the first and stays keyed at 1.
      assert entity_rows(ops, ctx.rocks_name) == [
               {"todo_a", 2, [1, 2]},
               {"todo_b", 1, [1]}
             ]
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

    test "writes one cf_component_entities op per unique key across the batch", ctx do
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

      index_ops =
        for {_op, cf, _key, _value} <- ops,
            cf == RocksDB.cf_component_entities(ctx.rocks_name),
            do: :ok

      # `todo_shared` repeats across both Actions, and both write the same
      # `todo/title` component: one model entry plus one component entry.
      assert length(index_ops) == 2
    end

    test "a drop deletes the component entry and keeps the model entry", ctx do
      ops = capture_batch_ops(ctx, [prepared_action("act_drop", [drop_update("todo_drop")])])

      assert index_ops(ops, ctx.rocks_name) == [
               {:put, component_key("todo", "todo_drop")},
               {:delete, component_key("todo/title", "todo_drop")}
             ]
    end

    test "a drop then a re-write in one Action ends with the entry present", ctx do
      ops =
        capture_batch_ops(ctx, [
          prepared_action("act_cycle", [
            drop_update("todo_cycle"),
            update("upd_reput", "todo_cycle")
          ])
        ])

      assert index_ops(ops, ctx.rocks_name) == [
               {:put, component_key("todo", "todo_cycle")},
               {:put, component_key("todo/title", "todo_cycle")}
             ]
    end

    test "the last Action wins a key written by several Actions of one flush", ctx do
      drop = prepared_action("act_first_drop", [drop_update("todo_lww")])
      put = prepared_action("act_second_put", [update("upd_lww", "todo_lww")])

      model = component_key("todo", "todo_lww")
      component = component_key("todo/title", "todo_lww")

      assert ctx |> capture_batch_ops([drop, put]) |> index_ops(ctx.rocks_name) ==
               [{:put, model}, {:put, component}]

      assert ctx |> capture_batch_ops([put, drop]) |> index_ops(ctx.rocks_name) ==
               [{:put, model}, {:delete, component}]
    end

    test "a delete names no component, so only the model entry is written", ctx do
      # The Writer resolves a delete's committed model while folding the
      # Action; the Committer only writes the ops it is handed.
      delete =
        prepared_action("act_delete", [delete_update("todo_gone")],
          component_entity_ops: [{:put, component_key("todo", "todo_gone")}]
        )

      assert capture_batch_ops(ctx, [delete]) |> index_ops(ctx.rocks_name) ==
               [{:put, component_key("todo", "todo_gone")}]
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
      component_entity_ops: Keyword.get(opts, :component_entity_ops, default_index_ops(updates)),
      affected_entities:
        Keyword.get(opts, :affected_entities, Enum.map(updates, &affected_entity/1))
    }
  end

  defp update(id, subject_id, opts \\ []) do
    component = Keyword.get(opts, :component, "todo/title")
    [model, field] = :binary.split(component, "/")

    %{
      id: id,
      subject_id: subject_id,
      component: component,
      model: model,
      field: field,
      method: Keyword.get(opts, :method, :replace),
      data: Keyword.get(opts, :data, %{"value" => "x"})
    }
  end

  defp drop_update(subject_id) do
    update("upd_drop_#{subject_id}", subject_id, method: :drop, data: nil)
  end

  defp delete_update(subject_id) do
    %{
      id: "upd_delete_#{subject_id}",
      subject_id: subject_id,
      component: nil,
      model: nil,
      field: nil,
      method: :delete,
      data: nil
    }
  end

  defp capture_batch_ops(ctx, prepared) do
    test_pid = self()
    ref = make_ref()
    committer = start_committer(ctx, fn ops, _opts -> send(test_pid, {:ops, ops}) && :ok end)

    :ok = Committer.commit(committer, ref, prepared, 1, length(prepared))
    assert_receive {:ops, ops}
    assert_receive {:committer_result, ^ref, :ok}

    ops
  end

  defp index_ops(ops, rocks_name) do
    cf = RocksDB.cf_component_entities(rocks_name)

    for op <- ops, elem(op, 1) == cf, do: {elem(op, 0), elem(op, 2)}
  end

  defp component_key(name, subject_id) do
    RocksDB.encode_component_entity_key(name, subject_id)
  end

  defp default_index_ops(updates) do
    ComponentEntityIndex.update_ops(updates) ++
      ComponentEntityIndex.model_ops(Enum.map(updates, &{&1.model, &1.subject_id}))
  end

  defp affected_entity(update), do: {update.subject_id, update.model}

  defp entity_rows(ops, rocks_name) do
    for {:put, cf, key, value} <- ops, cf == RocksDB.cf_entity_actions(rocks_name) do
      {entity_id, max_gsn} = RocksDB.decode_entity_flush_key(key)
      {entity_id, max_gsn, RocksDB.decode_gsn_list(value)}
    end
  end

  defp stored_action(etf, gsn), do: ActionFormat.decode(etf, gsn)
end
