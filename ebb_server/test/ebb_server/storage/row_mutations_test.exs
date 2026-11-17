defmodule EbbServer.Storage.RowMutationsTest do
  use ExUnit.Case, async: true

  alias EbbServer.Storage.RowMutations

  defp leaf(value, hlc), do: %{"value" => value, "hlc" => hlc}

  defp create(id, subject_id, model, hlc) do
    %{
      id: id,
      subject_id: subject_id,
      component: nil,
      model: model,
      field: nil,
      method: :create,
      data: nil,
      hlc: hlc
    }
  end

  defp component(id, subject_id, component, method, data) do
    [model, field] = :binary.split(component, "/")

    %{
      id: id,
      subject_id: subject_id,
      component: component,
      model: model,
      field: field,
      method: method,
      data: data
    }
  end

  defp delete(id, subject_id) do
    %{
      id: id,
      subject_id: subject_id,
      component: nil,
      model: nil,
      field: nil,
      method: :delete,
      data: nil
    }
  end

  # Owned by the test process, so it disappears with the test.
  defp unknown_type_index do
    table = :"row_mutations_types_#{System.unique_integer([:positive])}"
    :ets.new(table, [:set, :public, :named_table])
    table
  end

  test "folds a row's updates into one mutation, in first-appearance order" do
    table = unknown_type_index()

    updates = [
      create("c1", "note_1", "note", 1),
      component("u1", "note_1", "note/title", :replace, leaf("t", 1)),
      create("c2", "note_2", "note", 2),
      component("u2", "note_2", "note/title", :replace, leaf("other", 1)),
      component("u3", "note_1", "note/body", :merge, leaf("b", 1))
    ]

    assert [first, second] = RowMutations.fold(updates, entity_models: table)
    assert first.subject_id == "note_1"
    assert first.created?
    assert first.model == "note"
    assert first.data == %{"fields" => %{"title" => leaf("t", 1), "body" => leaf("b", 1)}}
    assert second.subject_id == "note_2"
    assert second.created?
  end

  test "the verb follows the explicit create, not the entity-model cache" do
    table = unknown_type_index()
    :ets.insert(table, {"note_1", "note"})

    [created] =
      RowMutations.fold(
        [
          create("c1", "note_1", "note", 10),
          component("u1", "note_1", "note/title", :merge, leaf("t", 1))
        ],
        entity_models: table
      )

    assert created.created?

    [patched] =
      RowMutations.fold(
        [component("u1", "note_9", "note/title", :replace, leaf("t", 1))],
        entity_models: table
      )

    refute patched.created?
  end

  test "a zero-component create is a user row with no fields" do
    [mutation] =
      RowMutations.fold([create("c1", "note_1", "note", 10)], entity_models: unknown_type_index())

    assert mutation.created?
    assert mutation.model == "note"
    assert mutation.kind == nil
    assert mutation.data == %{"fields" => %{}}
  end

  test "the create decides the model even when it arrives after a component" do
    [mutation] =
      RowMutations.fold(
        [
          component("u1", "note_1", "note/title", :replace, leaf("t", 1)),
          create("c1", "note_1", "note", 10)
        ],
        entity_models: unknown_type_index()
      )

    assert mutation.model == "note"
    assert mutation.created?
  end

  test "merge folds by the field's last-writer-wins rule" do
    [mutation] =
      RowMutations.fold(
        [
          create("c1", "note_1", "note", 1),
          component("u_low", "note_1", "note/title", :merge, leaf("low", 10)),
          component("u_high", "note_1", "note/title", :merge, leaf("high", 20))
        ],
        entity_models: unknown_type_index()
      )

    assert mutation.data["fields"]["title"] == leaf("high", 20)
  end

  test "drop removes the field and leaves the row" do
    [mutation] =
      RowMutations.fold(
        [
          create("c1", "note_1", "note", 1),
          component("u1", "note_1", "note/title", :replace, leaf("t", 1)),
          component("u2", "note_1", "note/body", :drop, nil)
        ],
        entity_models: unknown_type_index()
      )

    assert mutation.created?
    assert mutation.data == %{"fields" => %{"title" => leaf("t", 1)}}
  end

  test "a drop-only Action is an update, not a create" do
    [mutation] =
      RowMutations.fold(
        [component("u1", "note_1", "note/title", :drop, nil)],
        entity_models: unknown_type_index()
      )

    refute mutation.created?
    assert RowMutations.write?(mutation)
  end

  test "any delete for the subject collapses the row to one delete" do
    [mutation] =
      RowMutations.fold(
        [
          create("c1", "note_1", "note", 1),
          component("u1", "note_1", "note/title", :replace, leaf("t", 1)),
          delete("u2", "note_1")
        ],
        entity_models: unknown_type_index(),
        model_resolver: fn _id -> "note" end
      )

    assert %{deleted?: true, created?: false, data: nil, model: "note"} = mutation
    assert mutation.subject_id == "note_1"
  end

  test "a delete supersedes a create for the same row" do
    table = unknown_type_index()

    # The Action both creates and removes the row, so `created?` must not stand:
    # the bootstrap exemption would otherwise authorize a row the same Action
    # takes away.
    [created_then_deleted] =
      RowMutations.fold(
        [
          create("c1", "note_1", "note", 10),
          component("u1", "note_1", "note/title", :replace, leaf("t", 1)),
          delete("u2", "note_1")
        ],
        entity_models: table,
        model_resolver: fn _id -> "note" end
      )

    assert created_then_deleted.deleted?
    refute created_then_deleted.created?
  end

  test "a delete's model comes from the resolver, falling back to a sibling component" do
    table = unknown_type_index()

    [resolved] =
      RowMutations.fold([delete("u1", "rel_1")],
        entity_models: table,
        model_resolver: fn _id -> "relationship" end
      )

    assert resolved.model == "relationship"

    [from_sibling] =
      RowMutations.fold(
        [
          delete("u1", "rel_2"),
          component("u2", "rel_2", "relationship/source_id", :merge, leaf("note_1", 1))
        ],
        entity_models: table
      )

    assert from_sibling.model == "relationship"
  end

  test "a delete keeps a platform component's kind and committed model" do
    [mutation] =
      RowMutations.fold(
        [
          create("c1", "gm_1", "ebb", 1),
          component("u1", "gm_1", "ebb/grant", :replace, %{"value" => %{}}),
          delete("u2", "gm_1")
        ],
        entity_models: unknown_type_index(),
        model_resolver: fn _id -> "ebb" end
      )

    assert mutation.deleted?
    refute mutation.created?
    assert mutation.model == "ebb"
    assert mutation.kind == :grant
  end

  # A fold without the read its delete model needs cannot answer it, and
  # guessing would silently change what the rule engine authorizes. The
  # caller says which reads it has.
  test "a fold without a committed-model signal raises" do
    assert_raise ArgumentError, ~r/needs a committed-model signal/, fn ->
      RowMutations.fold([delete("u1", "note_1")])
    end
  end

  test "a delete's default model falls back to the by-id caches" do
    table = unknown_type_index()
    by_id = :"row_mutations_eg_by_id_#{System.unique_integer([:positive])}"
    :ets.new(by_id, [:set, :public, :named_table])

    :ets.insert(
      by_id,
      {"eg_1", %{id: "eg_1", entity_id: "note_1", group_id: "g_1"}}
    )

    # The model index knows nothing about the row — the lagging shape the
    # by-id caches exist for.
    [mutation] =
      RowMutations.fold([delete("u1", "eg_1")],
        entity_models: table,
        memberships_by_id: by_id
      )

    # A by-id cache row is a platform row, and every platform row is
    # committed under the one platform model.
    assert mutation.model == "ebb"
    assert mutation.deleted?
  end

  test "a delete is not a write" do
    [mutation] =
      RowMutations.fold([delete("u1", "note_1")],
        entity_models: unknown_type_index(),
        model_resolver: fn _id -> "note" end
      )

    refute RowMutations.write?(mutation)
  end

  test "the entity-model cache is the default committed-model signal" do
    table = unknown_type_index()
    :ets.insert(table, {"note_1", "note"})

    [known] =
      RowMutations.fold([delete("u1", "note_1")], entity_models: table)

    [unknown] =
      RowMutations.fold([delete("u2", "note_2")], entity_models: table)

    assert known.model == "note"
    assert unknown.model == nil
  end
end
