defmodule EbbServer.Storage.LogFirst.MemoryIndexTest do
  @moduledoc """
  The contract under test (#844, C1) is the shape, not a fast path: an append
  is acked with the log's cost and **nothing** indexed, and every read model is
  a function of the records the consumer is handed.

  So the tests are ordered around that split — acked but not applied, applied,
  rebuilt from the log — plus the four read shapes the prototype answers and
  the two ways a catch-up page can be read out of the segment.
  """

  use ExUnit.Case, async: true

  alias EbbServer.Storage.LogFirst.{MemoryIndex, Segment}

  setup do
    dir = Path.join(System.tmp_dir!(), "memory_index_test_#{System.unique_integer([:positive])}")
    index = MemoryIndex.open(dir: dir)

    on_exit(fn ->
      File.rm_rf(dir)
    end)

    {:ok, index: index, dir: dir}
  end

  describe "the ack is the log and nothing else" do
    test "an appended window is durable before any index exists", %{index: index} do
      {:ok, index, entries} = MemoryIndex.append_window(index, [frame(todo("1"))])

      # The ack returned: the record is on disk, and no derived table knows it.
      assert MemoryIndex.stats(index) == %{
               log_tail: 1,
               applied_gsn: 0,
               applied_actions: 0,
               lag: 1
             }

      assert :not_found = MemoryIndex.entity_state(index, "todo_1")
      assert :not_found = MemoryIndex.action_by_id(index, "a_1")

      assert {:ok, %{records: 1, tail_gsn: 1}} = Segment.inspect_file(index.segment.path)

      # The consumer step is what makes it readable.
      index = MemoryIndex.apply_window(index, entries)

      assert {:ok, %{last_gsn: 1}} = MemoryIndex.entity_state(index, "todo_1")
      assert {:ok, 1} = MemoryIndex.action_by_id(index, "a_1")
      assert MemoryIndex.stats(index).lag == 0
    end

    test "appending a second window does not touch the first window's index", %{index: index} do
      {:ok, index, entries} = MemoryIndex.append_window(index, [frame(todo("1"))])
      index = MemoryIndex.apply_window(index, entries)
      applied = MemoryIndex.memory(index)

      {:ok, index, _entries} = MemoryIndex.append_window(index, [frame(todo("2"))])

      assert MemoryIndex.memory(index).tables == applied.tables
      assert MemoryIndex.stats(index).lag == 1
    end
  end

  describe "entity_state/2" do
    test "materialises fields, model, components and the last GSN", %{index: index} do
      {:ok, index} =
        MemoryIndex.append_and_apply(index, [
          frame(action("1", [put("u1", "todo_1", "todo/title", "first")])),
          frame(action("2", [put("u2", "todo_1", "todo/done", true)]))
        ])

      assert {:ok, state} = MemoryIndex.entity_state(index, "todo_1")

      assert state.model == "todo"
      assert state.last_gsn == 2
      assert state.components == ["todo/done", "todo/title"]
      assert state.fields["title"]["value"] == "first"
      assert state.fields["done"]["value"] == true
    end

    test "applies the wire's LWW rule, not arrival order", %{index: index} do
      {:ok, index} =
        MemoryIndex.append_and_apply(index, [
          frame(action("1", [put("u1", "todo_1", "todo/title", "newer", 2_000)])),
          frame(action("2", [put("u2", "todo_1", "todo/title", "older", 1_000)]))
        ])

      assert {:ok, %{fields: fields}} = MemoryIndex.entity_state(index, "todo_1")
      assert fields["title"]["value"] == "newer"
    end

    test "a dropped component leaves the row readable", %{index: index} do
      {:ok, index} =
        MemoryIndex.append_and_apply(index, [
          frame(action("1", [put("u1", "todo_1", "todo/title", "first")])),
          frame(action("2", [put("u2", "todo_1", "todo/done", true)])),
          frame(action("3", [drop("u3", "todo_1", "todo/done")]))
        ])

      assert {:ok, %{components: ["todo/title"], last_gsn: 3}} =
               MemoryIndex.entity_state(index, "todo_1")
    end

    test "a deleted row is :not_found but its Action stays in the log", %{index: index} do
      {:ok, index} =
        MemoryIndex.append_and_apply(index, [
          frame(action("1", [put("u1", "todo_1", "todo/title", "first")])),
          frame(action("2", [delete_row("u2", "todo_1")]))
        ])

      assert :not_found = MemoryIndex.entity_state(index, "todo_1")
      assert {:ok, 2} = MemoryIndex.action_by_id(index, "a_2")
    end
  end

  describe "the derived indexes" do
    test "action_by_id is the dedup fast path", %{index: index} do
      {:ok, index, _entries} =
        MemoryIndex.append_window(index, [frame(todo("1")), frame(todo("2"))])

      {:ok, index} = MemoryIndex.append_and_apply(index, [frame(todo("3"))])

      assert :not_found = MemoryIndex.action_by_id(index, "a_1")
      assert :not_found = MemoryIndex.action_by_id(index, "a_never")

      {:ok, index, entries} = MemoryIndex.append_window(index, [frame(todo("4"))])
      index = MemoryIndex.apply_window(index, entries)

      assert {:ok, 3} = MemoryIndex.action_by_id(index, "a_3")
      assert {:ok, 4} = MemoryIndex.action_by_id(index, "a_4")
    end

    test "the existence index answers model and component entries", %{index: index} do
      {:ok, index} =
        MemoryIndex.append_and_apply(index, [
          frame(action("1", [put("u1", "todo_1", "todo/title", "first")]))
        ])

      assert MemoryIndex.exists?(index, "todo", nil, "todo_1")
      assert MemoryIndex.exists?(index, "todo", "todo/title", "todo_1")
      refute MemoryIndex.exists?(index, "todo", "todo/done", "todo_1")
      refute MemoryIndex.exists?(index, "todo", "todo/title", "todo_other")
      refute MemoryIndex.exists?(index, "note", "todo/title", "todo_1")
    end

    test "a drop removes the component entry and a delete removes the row's", %{index: index} do
      {:ok, index} =
        MemoryIndex.append_and_apply(index, [
          frame(
            action("1", [
              put("u1", "todo_1", "todo/title", "first"),
              put("u2", "todo_1", "todo/done", true)
            ])
          )
        ])

      assert MemoryIndex.exists?(index, "todo", "todo/done", "todo_1")

      {:ok, index} =
        MemoryIndex.append_and_apply(index, [
          frame(action("2", [drop("u3", "todo_1", "todo/done")]))
        ])

      refute MemoryIndex.exists?(index, "todo", "todo/done", "todo_1")
      assert MemoryIndex.exists?(index, "todo", "todo/title", "todo_1")

      {:ok, index} =
        MemoryIndex.append_and_apply(index, [
          frame(action("3", [delete_row("u4", "todo_1")]))
        ])

      refute MemoryIndex.exists?(index, "todo", nil, "todo_1")
      refute MemoryIndex.exists?(index, "todo", "todo/title", "todo_1")
    end

    test "entity groups come from the membership derivation", %{index: index} do
      {:ok, index} =
        MemoryIndex.append_and_apply(index, [
          frame(
            action("1", [
              put("uc1", "todo_1", "todo/title", "t"),
              put("u1", "eg_1", "entityGroup/entity_id", "todo_1"),
              put("u2", "eg_1", "entityGroup/group_id", "g_a")
            ])
          )
        ])

      assert {:ok, %{groups: ["g_a"]}} = MemoryIndex.entity_state(index, "todo_1")

      {:ok, index} =
        MemoryIndex.append_and_apply(index, [
          frame(
            action("2", [
              put("u3", "eg_2", "entityGroup/entity_id", "todo_1"),
              put("u4", "eg_2", "entityGroup/group_id", "g_b")
            ])
          )
        ])

      assert {:ok, %{groups: ["g_a", "g_b"]}} = MemoryIndex.entity_state(index, "todo_1")

      {:ok, index} =
        MemoryIndex.append_and_apply(index, [
          frame(action("3", [delete_row("u5", "eg_1")]))
        ])

      assert {:ok, %{groups: ["g_b"]}} = MemoryIndex.entity_state(index, "todo_1")
    end
  end

  describe "updates_for_group/4" do
    setup %{index: index} do
      {:ok, index} =
        MemoryIndex.append_and_apply(
          index,
          Enum.map(1..10, fn seq ->
            group = if rem(seq, 2) == 0, do: "g_even", else: "g_odd"

            frame(action("#{seq}", [put("u#{seq}", "todo_#{seq}", "todo/title", "t#{seq}")]), [
              [group]
            ])
          end)
        )

      {:ok, index: index}
    end

    test "returns one group's Actions in GSN order, bounded", %{index: index} do
      assert {:ok, page} = MemoryIndex.updates_for_group(index, "g_even", 1, 3)
      assert Enum.map(page, & &1["gsn"]) == [2, 4, 6]

      assert {:ok, page} = MemoryIndex.updates_for_group(index, "g_even", 1, 100)
      assert Enum.map(page, & &1["gsn"]) == [2, 4, 6, 8, 10]

      assert {:ok, page} = MemoryIndex.updates_for_group(index, "g_odd", 1, 2)
      assert Enum.map(page, & &1["gsn"]) == [1, 3]
    end

    test "from_gsn is inclusive and a page past the tail is empty", %{index: index} do
      assert {:ok, [%{"gsn" => 4} | _]} = MemoryIndex.updates_for_group(index, "g_even", 4, 2)
      assert {:ok, []} = MemoryIndex.updates_for_group(index, "g_even", 11, 10)
      assert {:ok, []} = MemoryIndex.updates_for_group(index, "g_missing", 1, 10)
    end

    test "the dense offset index and the sparse segment index agree", %{index: index} do
      {:ok, via_offsets} = MemoryIndex.updates_for_group(index, "g_even", 1, 100, read: :offsets)
      {:ok, via_sparse} = MemoryIndex.updates_for_group(index, "g_even", 1, 100, read: :sparse)

      assert via_offsets == via_sparse
    end

    test "an Action filed under two groups appears in both pages", %{index: index} do
      {:ok, index} =
        MemoryIndex.append_and_apply(index, [
          frame(
            action("both", [
              put("ub1", "todo_both", "todo/title", "x"),
              put("ub2", "todo_both", "todo/done", false)
            ]),
            [["g_even"], ["g_odd"]]
          )
        ])

      assert Enum.any?(
               elem(MemoryIndex.updates_for_group(index, "g_even", 11, 10), 1),
               &(&1["id"] == "a_both")
             )

      assert Enum.any?(
               elem(MemoryIndex.updates_for_group(index, "g_odd", 11, 10), 1),
               &(&1["id"] == "a_both")
             )
    end
  end

  describe "rebuild/2" do
    test "drops every index and replays the log to the same answers", %{index: index} do
      {:ok, index} =
        MemoryIndex.append_and_apply(
          index,
          Enum.map(1..20, fn seq ->
            frame(action("#{seq}", [put("u#{seq}", "todo_#{seq}", "todo/title", "t#{seq}")]))
          end)
        )

      before = snapshot(index)

      assert {:ok, index, stats} = MemoryIndex.rebuild(index)
      assert stats.records == 20
      assert stats.scan_us > 0 and stats.replay_us > 0
      assert snapshot(index) == before

      assert MemoryIndex.stats(index) == %{
               log_tail: 20,
               applied_gsn: 20,
               applied_actions: 20,
               lag: 0
             }
    end

    test "replays only the intact prefix of a torn tail", %{index: index} do
      {:ok, index, entries} =
        MemoryIndex.append_window(
          index,
          Enum.map(1..10, fn seq ->
            frame(action("#{seq}", [put("u#{seq}", "todo_#{seq}", "todo/title", "t#{seq}")]))
          end)
        )

      # Corrupt the last record's body, as a half-written append would leave it.
      last = List.last(entries)
      :ok = :file.pwrite(index.segment.fd, last.offset + Segment.header_size(), "garbage")

      assert {:ok, index, stats} = MemoryIndex.rebuild(index)
      assert stats.records == 9
      assert stats.repairs != []
      assert MemoryIndex.stats(index).log_tail == 9
      assert {:ok, 9} = MemoryIndex.action_by_id(index, "a_9")
      assert :not_found = MemoryIndex.entity_state(index, "todo_10")
    end

    test "a pre-written segment replays cleanly and truncates the zero tail", %{dir: dir} do
      index = MemoryIndex.open(dir: dir, prewrite_bytes: 4 * 1024 * 1024)

      {:ok, index} =
        MemoryIndex.append_and_apply(index, [
          frame(todo("1")),
          frame(todo("2"))
        ])

      assert index.segment.offset > 0
      assert File.stat!(index.segment.path).size >= 4 * 1024 * 1024

      assert {:ok, index, stats} = MemoryIndex.rebuild(index)
      assert stats.records == 2
      assert {:ok, %{last_gsn: 2}} = MemoryIndex.entity_state(index, "todo_2")
    end
  end

  ## Fixtures

  defp snapshot(index) do
    %{
      one: MemoryIndex.entity_state(index, "todo_1"),
      last: MemoryIndex.entity_state(index, "todo_20"),
      dedup: MemoryIndex.action_by_id(index, "a_7"),
      page: MemoryIndex.updates_for_group(index, "g_bench", 1, 100),
      existence: MemoryIndex.exists?(index, "todo", "todo/title", "todo_7")
    }
  end

  defp todo(seq) do
    action(seq, [
      put("u#{seq}", "todo_#{seq}", "todo/title", "title-#{seq}"),
      put("ug#{seq}", "todo_#{seq}", "todo/done", false)
    ])
  end

  defp action(seq, updates) do
    %{id: "a_#{seq}", actor_id: "a_bench", hlc: 1_000, updates: updates}
  end

  defp put(id, subject_id, component, value, hlc \\ 1_000) do
    %{
      id: id,
      subject_id: subject_id,
      component: component,
      method: "replace",
      data: %{"value" => value, "hlc" => hlc}
    }
  end

  defp drop(id, subject_id, component) do
    %{id: id, subject_id: subject_id, component: component, method: "drop", data: nil}
  end

  defp delete_row(id, subject_id) do
    %{id: id, subject_id: subject_id, component: nil, method: "delete", data: nil}
  end

  defp frame(action, scopes \\ nil) do
    scopes = scopes || Enum.map(action.updates, fn _ -> ["g_bench"] end)
    MemoryIndex.frame(action, scopes)
  end
end
