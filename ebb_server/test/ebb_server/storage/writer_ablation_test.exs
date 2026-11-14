defmodule EbbServer.Storage.WriterAblationTest do
  @moduledoc """
  Behavioral tests for the bench-only Writer ablation seam.

  Each test drives one ablated phase through `Writer.write_actions/1` with
  a capturing `commit_fn`, then asserts on the emitted ops (or the effect
  the phase would have had), so the seam's semantics stay pinned without
  reaching into private functions.
  """

  use ExUnit.Case, async: false

  alias EbbServer.Storage.{
    ComponentEntityIndex,
    EntityTypeCache,
    RocksDB,
    WatermarkTracker,
    Writer
  }

  import EbbServer.TestHelpers

  setup do
    cache = start_isolated_cache()
    %{name: rocks_name, dir: rocks_dir} = start_rocks()
    {:ok, Map.merge(cache, %{rocks_name: rocks_name, rocks_dir: rocks_dir})}
  end

  describe "op emission" do
    test "without ablation the dedup index is written", ctx do
      writer = start_capturing_writer(ctx, [])

      assert {:ok, {1, 1}, []} = Writer.write_actions([validated_action()], writer)

      assert_receive {:captured_ops, ops}
      assert length(puts_to(ops, RocksDB.cf_action_dedup(ctx.rocks_name))) == 1
    end

    test ":dedup drops the cf_action_dedup op", ctx do
      writer = start_capturing_writer(ctx, [:dedup])

      assert {:ok, {1, 1}, []} = Writer.write_actions([validated_action()], writer)

      assert_receive {:captured_ops, ops}
      assert puts_to(ops, RocksDB.cf_action_dedup(ctx.rocks_name)) == []

      # The log record itself is never ablated.
      assert length(puts_to(ops, RocksDB.cf_actions(ctx.rocks_name))) == 1
    end

    test ":entity_actions drops only cf_entity_actions", ctx do
      writer = start_capturing_writer(ctx, [:entity_actions])
      subject_id = "todo_ablated_entity_actions"
      action = action_for(subject_id)

      assert {:ok, {1, 1}, []} = Writer.write_actions([action], writer)

      assert_receive {:captured_ops, ops}
      assert puts_to(ops, RocksDB.cf_entity_actions(ctx.rocks_name)) == []

      # The in-memory index is untouched by the ablation: one model entry plus
      # one component entry for the one component Update.
      assert ComponentEntityIndex.component_entry_ids("todo", index_opts(ctx)) == [subject_id]

      assert ComponentEntityIndex.component_entry_ids("todo/title", index_opts(ctx)) == [
               subject_id
             ]
    end

    test ":component_entries keeps model entries and drops component entries", ctx do
      writer = start_capturing_writer(ctx, [:component_entries])
      subject_id = "todo_ablated_component_entries"
      action = action_for(subject_id)

      assert {:ok, {1, 1}, []} = Writer.write_actions([action], writer)

      assert_receive {:captured_ops, ops}

      # The model entry is the pre-#799 one-row-per-row shape; only the
      # component entry is gone.
      assert ComponentEntityIndex.component_entry_ids("todo", index_opts(ctx)) == [subject_id]
      assert ComponentEntityIndex.component_entry_ids("todo/title", index_opts(ctx)) == []
      assert length(puts_to(ops, RocksDB.cf_entity_actions(ctx.rocks_name))) == 1
    end

    test ":component_entities leaves the in-memory index empty", ctx do
      writer = start_capturing_writer(ctx, [:component_entities])

      action = action_for("todo_ablated_component_entities")

      assert {:ok, {1, 1}, []} = Writer.write_actions([action], writer)

      assert_receive {:captured_ops, ops}
      assert ComponentEntityIndex.size(index_opts(ctx)) == 0
      assert length(puts_to(ops, RocksDB.cf_entity_actions(ctx.rocks_name))) == 1
    end

    test ":entity_index drops cf_entity_actions and leaves the index empty", ctx do
      writer = start_capturing_writer(ctx, [:entity_index])

      action = action_for("todo_ablated_entity_index")

      assert {:ok, {1, 1}, []} = Writer.write_actions([action], writer)

      assert_receive {:captured_ops, ops}
      assert puts_to(ops, RocksDB.cf_entity_actions(ctx.rocks_name)) == []
      assert ComponentEntityIndex.size(index_opts(ctx)) == 0
      assert length(puts_to(ops, RocksDB.cf_actions(ctx.rocks_name))) == 1
    end

    test ":group_index drops cf_group_actions while groups still resolve", ctx do
      writer = start_capturing_writer(ctx, [:group_index])

      assert {:ok, {1, 1}, []} = Writer.write_actions([grouped_action()], writer)

      assert_receive {:captured_ops, ops}
      assert puts_to(ops, RocksDB.cf_group_actions(ctx.rocks_name)) == []

      # Resolution still happened: the stored scopes carry the group for both
      # subjects of the Action, one entry each.
      scopes = stored_scopes(ops, ctx.rocks_name)
      assert length(scopes) == 2
      assert Map.new(scopes) == %{"todo_grouped" => ["g_grouped"], "eg_grouped" => ["g_grouped"]}
    end

    test ":group_resolution lists every subject with no groups", ctx do
      writer = start_capturing_writer(ctx, [:group_resolution])

      assert {:ok, {1, 1}, []} = Writer.write_actions([grouped_action()], writer)

      assert_receive {:captured_ops, ops}
      # Ablated resolution is not an absent list: every folded subject is
      # listed with `[]`, so the frame still records one entry per subject.
      scopes = stored_scopes(ops, ctx.rocks_name)
      assert length(scopes) == 2
      assert Map.new(scopes) == %{"todo_grouped" => [], "eg_grouped" => []}
    end

    test ":build stores an empty payload", ctx do
      writer = start_capturing_writer(ctx, [:build])

      assert {:ok, {1, 1}, []} = Writer.write_actions([validated_action()], writer)

      assert_receive {:captured_ops, ops}

      assert stored_payload(ops, ctx.rocks_name) == %{}
    end

    test ":encode stores a structurally valid empty payload", ctx do
      writer = start_capturing_writer(ctx, [:encode])

      assert {:ok, {1, 1}, []} = Writer.write_actions([validated_action()], writer)

      assert_receive {:captured_ops, ops}

      assert %{"id" => "ablated", "actor_id" => "ablated", "hlc" => 0, "updates" => []} =
               stored_payload(ops, ctx.rocks_name)
    end

    test "`all` leaves exactly one cf_actions put per Action and nothing else", ctx do
      action = grouped_action()
      writer = start_capturing_writer(ctx, all_phases())

      assert {:ok, {1, 1}, []} = Writer.write_actions([action], writer)

      assert_receive {:captured_ops, ops}
      assert single_cf_actions_put?(ops, ctx.rocks_name)
      assert length(ops) == 1
    end
  end

  describe "post-commit side effects" do
    test ":dirty leaves no pending or settled mark", ctx do
      writer = start_capturing_writer(ctx, [:dirty])

      assert {:ok, {1, 1}, []} = Writer.write_actions([validated_action()], writer)

      assert :ets.info(ctx.dirty_set, :size) == 0
    end

    test "without :dirty the entity is marked", ctx do
      writer = start_capturing_writer(ctx, [])

      assert {:ok, {1, 1}, []} = Writer.write_actions([validated_action()], writer)

      assert :ets.info(ctx.dirty_set, :size) > 0
    end

    test ":cache skips the entity-type cache mutation", ctx do
      writer = start_capturing_writer(ctx, [:cache])

      action = validated_action(%{updates: [validated_update(%{subject_id: "todo_nocache"})]})

      assert {:ok, {1, 1}, []} = Writer.write_actions([action], writer)

      assert EntityTypeCache.get_type("todo_nocache", ctx.entity_types) == nil
    end

    test "without :cache the entity type is cached", ctx do
      writer = start_capturing_writer(ctx, [])

      action = validated_action(%{updates: [validated_update(%{subject_id: "todo_cache"})]})

      assert {:ok, {1, 1}, []} = Writer.write_actions([action], writer)

      assert EntityTypeCache.get_type("todo_cache", ctx.entity_types) == "todo"
    end

    test ":watermark never advances the frontier", ctx do
      writer = start_capturing_writer(ctx, [:watermark])

      assert {:ok, {1, 1}, []} = Writer.write_actions([validated_action()], writer)

      assert WatermarkTracker.committed_watermark(ctx.watermark_tracker) == 0
    end

    test "without :watermark the frontier advances", ctx do
      writer = start_capturing_writer(ctx, [])

      assert {:ok, {1, 1}, []} = Writer.write_actions([validated_action()], writer)

      assert WatermarkTracker.committed_watermark(ctx.watermark_tracker) == 1
    end

    test ":fanout sends no batch_committed to the router", ctx do
      router = register_self_as_router()
      writer = start_capturing_writer(ctx, [:fanout], %{fan_out_router: router})

      assert {:ok, {1, 1}, []} = Writer.write_actions([validated_action()], writer)

      refute_receive {:batch_committed, _start, _end, _groups, _at, _payloads, _actors}, 100
    end

    test "without :fanout the router is notified", ctx do
      router = register_self_as_router()
      writer = start_capturing_writer(ctx, [], %{fan_out_router: router})

      assert {:ok, {1, 1}, []} = Writer.write_actions([validated_action()], writer)

      assert_receive {:batch_committed, 1, 1, _groups, _at, _payloads, _actors}
    end
  end

  defp start_capturing_writer(ctx, ablate, extra \\ %{}) do
    opts =
      writer_opts(ctx, %{ablate: ablate, commit_fn: capturing_commit_fn(self())})
      |> Map.merge(extra)

    %{name: writer_name} = start_writer(opts)
    writer_name
  end

  defp capturing_commit_fn(test_pid) do
    fn ops, _opts ->
      send(test_pid, {:captured_ops, ops})
      :ok
    end
  end

  defp register_self_as_router do
    name = :"writer_ablation_router_#{System.unique_integer([:positive])}"
    Process.register(self(), name)
    name
  end

  defp all_phases do
    [
      :dedup,
      :group_resolution,
      :build,
      :encode,
      :entity_actions,
      :component_entities,
      :entity_index,
      :group_index,
      :dirty,
      :cache,
      :watermark,
      :fanout
    ]
  end

  defp puts_to(ops, cf) do
    for {:put, ^cf, _key, _value} <- ops, do: :ok
  end

  defp index_opts(ctx) do
    [
      component_index: ctx.component_index,
      component_entity_labels: ctx.component_entity_labels
    ]
  end

  defp action_for(subject_id) do
    validated_action(%{
      updates: [validated_component(subject_id, "todo/title", %{"value" => "x"})]
    })
  end

  defp stored_scopes(ops, rocks_name) do
    <<size::32, _payload::binary-size(size), scopes_etf::binary>> =
      stored_value(ops, rocks_name)

    :erlang.binary_to_term(scopes_etf, [:safe])
  end

  defp stored_payload(ops, rocks_name) do
    <<size::32, payload_etf::binary-size(size), _scopes::binary>> =
      stored_value(ops, rocks_name)

    :erlang.binary_to_term(payload_etf, [:safe])
  end

  # The raw cf_actions value of the captured batch.
  defp stored_value(ops, rocks_name) do
    [value] =
      for {:put, cf, _key, value} <- ops, cf == RocksDB.cf_actions(rocks_name) do
        value
      end

    value
  end

  defp grouped_action do
    hlc = generate_hlc()

    %{
      id: "act_grouped",
      actor_id: "a_test",
      hlc: hlc,
      updates:
        [validated_component("todo_grouped", "todo/title", %{"value" => "x", "hlc" => hlc})] ++
          [
            validated_component("eg_grouped", "ebb/membership", %{
              "value" => %{"entity_id" => "todo_grouped", "group_id" => "g_grouped"},
              "hlc" => hlc
            })
          ]
    }
  end

  defp single_cf_actions_put?(ops, rocks_name) do
    cf = RocksDB.cf_actions(rocks_name)
    match?([{:put, ^cf, _key, _value}], ops)
  end
end
