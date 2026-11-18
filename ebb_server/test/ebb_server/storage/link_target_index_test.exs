defmodule EbbServer.Storage.LinkTargetIndexTest do
  use ExUnit.Case, async: false

  alias EbbServer.Storage.{LinkTargetIndex, RowMutations, SystemCache, Writer}

  import EbbServer.TestHelpers

  describe "update_ops/1" do
    test "derives one put per present leaf at depth three" do
      update =
        link_update("todo_1", %{
          "assignee" => %{"todo" => %{"todo_2" => present_leaf(), "todo_3" => present_leaf()}},
          "blocked_by" => %{"todo" => %{"todo_4" => present_leaf()}}
        })

      assert Enum.sort(LinkTargetIndex.update_ops([update])) ==
               Enum.sort([
                 {:put, {"todo", "todo_2", "todo_1"}},
                 {:put, {"todo", "todo_3", "todo_1"}},
                 {:put, {"todo", "todo_4", "todo_1"}}
               ])
    end

    test "a tombstoned leaf removes that edge" do
      update = link_update("todo_1", %{"assignee" => %{"todo" => %{"todo_2" => tombstone()}}})

      assert LinkTargetIndex.update_ops([update]) == [{:delete, {"todo", "todo_2", "todo_1"}}]
    end

    test "a field or type subtree replaced wholesale indexes nothing" do
      # A patch that re-writes a level instead of one leaf does not restate the
      # entries it discards, so guessing would index edges the row may not
      # carry. The boot rebuild cannot recover one either — it runs this same
      # function over the same log — so the dropped edges come back only when a
      # later write names their keys.
      whole_type = %{
        "map" => %{"assignee" => %{"map" => %{"todo" => present_leaf()}}}
      }

      whole_field = %{"map" => %{"assignee" => present_leaf()}}

      assert LinkTargetIndex.update_ops([link_update("todo_1", %{}, whole_type)]) == []
      assert LinkTargetIndex.update_ops([link_update("todo_1", %{}, whole_field)]) == []
    end

    test "a patch that is not the component's map shape indexes nothing" do
      for data <- [nil, %{}, %{"value" => true}, %{"map" => []}, %{"map" => "x"}] do
        update = %{link_update("todo_1", %{}) | data: data}

        assert LinkTargetIndex.update_ops([update]) == []
      end
    end

    test "a leaf without a value is malformed, not a presence" do
      broken = link_update("todo_1", %{"assignee" => %{"todo" => %{"todo_2" => %{"hlc" => 1}}}})

      assert LinkTargetIndex.update_ops([broken]) == []
    end

    test "only a component write of the link component derives edges" do
      present = link_update("todo_1", %{"assignee" => %{"todo" => %{"todo_2" => present_leaf()}}})

      for update <- [
            %{present | method: :drop},
            %{present | method: :create},
            %{present | method: :delete},
            %{present | component: "todo/title"},
            %{present | subject_id: nil}
          ] do
        assert LinkTargetIndex.update_ops([update]) == []
      end

      assert LinkTargetIndex.update_ops([%{present | method: :replace}]) ==
               [{:put, {"todo", "todo_2", "todo_1"}}]
    end

    # Boot replays stored frames through `RowMutations.from_stored/1`, so the
    # op function must read that shape as well as the validated one.
    test "reads a stored frame through the same function" do
      stored =
        RowMutations.from_stored(%{
          "id" => "upd_link",
          "subject_id" => "todo_1",
          "component" => "ebb/link",
          "method" => "merge",
          "data" => %{
            "map" => %{
              "assignee" => %{"map" => %{"todo" => %{"map" => %{"todo_2" => present_leaf()}}}}
            }
          }
        })

      assert LinkTargetIndex.update_ops([stored]) == [{:put, {"todo", "todo_2", "todo_1"}}]
    end
  end

  describe "reduce_ops/1" do
    test "the last write per key wins" do
      ops = [
        {:put, {"todo", "todo_2", "todo_1"}},
        {:delete, {"todo", "todo_2", "todo_1"}},
        {:delete, {"todo", "todo_3", "todo_1"}},
        {:put, {"todo", "todo_3", "todo_1"}}
      ]

      assert Enum.sort(LinkTargetIndex.reduce_ops(ops)) ==
               Enum.sort([
                 {:delete, {"todo", "todo_2", "todo_1"}},
                 {:put, {"todo", "todo_3", "todo_1"}}
               ])
    end

    test "reduce_batch_ops/1 folds the actions of one flush in order" do
      first = [{:put, {"todo", "todo_2", "todo_1"}}]
      second = [{:delete, {"todo", "todo_2", "todo_1"}}]

      assert LinkTargetIndex.reduce_batch_ops([first, second]) == [
               {:delete, {"todo", "todo_2", "todo_1"}}
             ]
    end
  end

  describe "apply_ops/2 and source_ids/3" do
    setup do
      opts = [
        link_targets: :"lti_entries_#{System.unique_integer([:positive])}",
        link_target_labels: :"lti_labels_#{System.unique_integer([:positive])}"
      ]

      LinkTargetIndex.reset(opts)

      on_exit(fn ->
        {entries, labels} = LinkTargetIndex.tables(opts)

        for table <- [entries, labels] do
          try do
            :ets.delete(table)
          rescue
            _ -> :ok
          end
        end
      end)

      %{index: opts}
    end

    test "answers the sources of one (type, target) ascending", %{index: index} do
      LinkTargetIndex.apply_ops(
        [
          {:put, {"todo", "todo_9", "todo_c"}},
          {:put, {"todo", "todo_9", "todo_a"}},
          {:put, {"todo", "todo_9", "todo_b"}},
          {:put, {"todo", "todo_other", "todo_z"}},
          {:put, {"note", "todo_9", "note_a"}}
        ],
        index
      )

      assert LinkTargetIndex.source_ids("todo", "todo_9", index) == ["todo_a", "todo_b", "todo_c"]
      assert LinkTargetIndex.source_ids("todo", "todo_other", index) == ["todo_z"]
      assert LinkTargetIndex.source_ids("note", "todo_9", index) == ["note_a"]
    end

    test "an unknown type or target is empty, not an error", %{index: index} do
      assert LinkTargetIndex.source_ids("todo", "todo_none", index) == []
      assert LinkTargetIndex.source_ids("nope", "todo_none", index) == []
    end

    test "a delete removes the entry and leaves its siblings", %{index: index} do
      LinkTargetIndex.apply_ops(
        [
          {:put, {"todo", "todo_9", "todo_a"}},
          {:put, {"todo", "todo_9", "todo_b"}}
        ],
        index
      )

      LinkTargetIndex.apply_ops([{:delete, {"todo", "todo_9", "todo_a"}}], index)

      assert LinkTargetIndex.source_ids("todo", "todo_9", index) == ["todo_b"]

      # An uninterned type has nothing to remove.
      LinkTargetIndex.apply_ops([{:delete, {"never_interned", "t", "s"}}], index)
      assert LinkTargetIndex.size(index) == 1
    end

    test "a second source may carry the same edge key", %{index: index} do
      LinkTargetIndex.apply_ops(
        [
          {:put, {"todo", "todo_9", "todo_a"}},
          {:put, {"todo", "todo_9", "todo_b"}}
        ],
        index
      )

      assert LinkTargetIndex.source_ids("todo", "todo_9", index) == ["todo_a", "todo_b"]

      LinkTargetIndex.apply_ops([{:delete, {"todo", "todo_9", "todo_a"}}], index)

      assert LinkTargetIndex.source_ids("todo", "todo_9", index) == ["todo_b"]
    end
  end

  describe "boot rebuild" do
    setup do
      cache = start_isolated_cache()
      %{name: rocks_name, dir: rocks_dir} = start_rocks()
      %{name: sqlite_name} = start_sqlite(rocks_dir)
      %{name: writer_name} = start_writer(Map.put(cache, :rocks_name, rocks_name))

      Map.merge(cache, %{
        rocks_name: rocks_name,
        sqlite_name: sqlite_name,
        writer_name: writer_name
      })
    end

    test "a boot rebuild answers exactly what the live apply answered", ctx do
      hlc = generate_hlc()

      action = %{
        id: "act_links_#{System.unique_integer([:positive])}",
        actor_id: "a_links",
        hlc: hlc,
        updates: [
          validated_create("todo_1", "todo", hlc: hlc),
          validated_create("todo_2", "todo", hlc: hlc),
          link_update("todo_1", %{
            "assignee" => %{
              "todo" => %{"todo_2" => present_leaf(hlc), "todo_3" => present_leaf(hlc)}
            },
            "blocked_by" => %{"todo" => %{"todo_4" => present_leaf(hlc)}}
          }),
          # The same Action adds and removes one edge of a second source, so
          # the live apply has to reduce in wire order to agree with the log.
          link_update("todo_2", %{"assignee" => %{"todo" => %{"todo_2" => present_leaf(hlc)}}})
        ]
      }

      # A removal of an edge the index already holds, in a later Action.
      removal = %{
        id: "act_unlink_#{System.unique_integer([:positive])}",
        actor_id: "a_links",
        hlc: generate_hlc(),
        updates: [link_update("todo_1", %{"assignee" => %{"todo" => %{"todo_3" => tombstone()}}})]
      }

      assert {:ok, {1, 2}, []} = Writer.write_actions([action, removal], ctx.writer_name)

      live = todo_edges(ctx)

      assert live == [
               {"todo_2", ["todo_1", "todo_2"]},
               {"todo_4", ["todo_1"]}
             ]

      # A restart loses the index; the seed rebuilds it from the action log.
      LinkTargetIndex.reset(index_opts(ctx))
      assert todo_edges(ctx) == []

      :ok = SystemCache.populate_system_caches(populate_opts(ctx))

      assert todo_edges(ctx) == live
    end

    test "an abandoned commit applies no entry", ctx do
      # The index is derived state, so it is applied only once the range is
      # durable: a failed commit must leave nothing a restart would undo.
      %{name: failing_writer} =
        start_writer(
          Map.merge(ctx, %{commit_fn: fn _ops, _opts -> {:error, :injected_failure} end})
        )

      hlc = generate_hlc()

      action =
        validated_action(%{
          actor_id: "a_links",
          updates: [
            validated_create("todo_1", "todo", hlc: hlc),
            link_update("todo_1", %{"assignee" => %{"todo" => %{"todo_2" => present_leaf(hlc)}}})
          ]
        })

      assert {:error, _reason} = Writer.write_actions([action], failing_writer)

      assert LinkTargetIndex.source_ids("todo", "todo_2", index_opts(ctx)) == []
    end

    # A `drop` names the component and not the edges it held, so it cannot
    # remove them: the entries stay as candidates, exactly as a row `delete`
    # leaves them, with the row tombstone the liveness filter.
    test "dropping the link component leaves the entries indexed", ctx do
      hlc = generate_hlc()

      put =
        validated_action(%{
          actor_id: "a_links",
          updates: [
            validated_create("todo_1", "todo", hlc: hlc),
            link_update("todo_1", %{"assignee" => %{"todo" => %{"todo_2" => present_leaf(hlc)}}})
          ]
        })

      drop =
        validated_action(%{
          actor_id: "a_links",
          updates: [
            validated_component("todo_1", "ebb/link", nil, method: :drop, id: "upd_drop")
          ]
        })

      assert {:ok, {1, 2}, []} = Writer.write_actions([put, drop], ctx.writer_name)

      assert LinkTargetIndex.source_ids("todo", "todo_2", index_opts(ctx)) == ["todo_1"]
    end

    # A row delete leaves its entries behind, exactly as it leaves component
    # entries: the row tombstone is the liveness filter, not this index.
    test "a row delete leaves its edges indexed", ctx do
      hlc = generate_hlc()

      put =
        validated_action(%{
          actor_id: "a_links",
          updates: [
            validated_create("todo_1", "todo", hlc: hlc),
            link_update("todo_1", %{"assignee" => %{"todo" => %{"todo_2" => present_leaf(hlc)}}})
          ]
        })

      remove =
        validated_action(%{
          actor_id: "a_links",
          updates: [row_delete("todo_1")]
        })

      assert {:ok, {1, 2}, []} = Writer.write_actions([put, remove], ctx.writer_name)

      assert LinkTargetIndex.source_ids("todo", "todo_2", index_opts(ctx)) == ["todo_1"]
    end
  end

  # Every `(target, sources)` pair the index holds for one type. The type is
  # interned, so the label table is where its id comes from.
  defp todo_edges(ctx) do
    {entries, labels} = LinkTargetIndex.tables(index_opts(ctx))

    case :ets.lookup(labels, "todo") do
      [] ->
        []

      [{_, label_id}] ->
        entries
        |> :ets.tab2list()
        |> Enum.flat_map(fn
          {{^label_id, target_id, source_id}, _} -> [{target_id, source_id}]
          _ -> []
        end)
        |> Enum.group_by(&elem(&1, 0), &elem(&1, 1))
        |> Enum.map(fn {target_id, sources} -> {target_id, Enum.sort(sources)} end)
        |> Enum.sort()
    end
  end

  defp index_opts(ctx) do
    [link_targets: ctx.link_targets, link_target_labels: ctx.link_target_labels]
  end

  defp link_update(subject_id, edges, data \\ nil) do
    validated_component(subject_id, "ebb/link", data || %{"map" => edge_map(edges)},
      method: :merge
    )
  end

  defp edge_map(edges) do
    Map.new(edges, fn {field, types} ->
      {field, %{"map" => Map.new(types, fn {type, targets} -> {type, %{"map" => targets}} end)}}
    end)
  end

  defp row_delete(subject_id) do
    %{
      id: "upd_delete_" <> subject_id,
      subject_id: subject_id,
      component: nil,
      model: nil,
      field: nil,
      method: :delete,
      data: nil
    }
  end

  defp present_leaf(hlc \\ 1), do: %{"value" => true, "hlc" => hlc, "update_id" => "u_leaf"}
  defp tombstone, do: %{"value" => nil, "hlc" => 1, "update_id" => "u_leaf"}

  defp populate_opts(ctx) do
    [
      rocks_name: ctx.rocks_name,
      sqlite_name: ctx.sqlite_name,
      dirty_set: ctx.dirty_set,
      table: ctx.grants,
      grants_by_id: ctx.grants_by_id,
      grants_by_group: ctx.grants_by_group,
      memberships: ctx.memberships,
      memberships_by_id: ctx.memberships_by_id,
      memberships_by_group: ctx.memberships_by_group,
      entity_models: ctx.entity_models,
      component_index: ctx.component_index,
      component_entity_labels: ctx.component_entity_labels,
      group_apps: ctx.group_apps,
      link_targets: ctx.link_targets,
      link_target_labels: ctx.link_target_labels
    ]
  end
end
