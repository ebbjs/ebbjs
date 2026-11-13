defmodule EbbServer.Storage.RowMutationsTest do
  use ExUnit.Case, async: true

  alias EbbServer.Storage.RowMutations

  defp leaf(value, hlc), do: %{"value" => value, "hlc" => hlc}

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

  test "folds a row's components into one mutation, in first-appearance order" do
    table = unknown_type_index()

    updates = [
      component("u1", "note_1", "note/title", :replace, leaf("t", 1)),
      component("u2", "note_2", "note/title", :replace, leaf("other", 1)),
      component("u3", "note_1", "note/body", :merge, leaf("b", 1))
    ]

    assert [first, second] = RowMutations.fold(updates, entity_types: table)
    assert first.subject_id == "note_1"
    assert first.method == :put
    assert first.model == "note"
    assert first.data == %{"fields" => %{"title" => leaf("t", 1), "body" => leaf("b", 1)}}
    assert second.subject_id == "note_2"
  end

  test "a known row folds to :patch, and a request-created id is not new" do
    table = unknown_type_index()
    :ets.insert(table, {"note_1", "note"})

    [known] =
      RowMutations.fold([component("u1", "note_1", "note/title", :merge, leaf("t", 1))],
        entity_types: table
      )

    assert known.method == :patch

    [created] =
      RowMutations.fold(
        [component("u1", "note_9", "note/title", :replace, leaf("t", 1))],
        entity_types: table,
        created: MapSet.new(["note_9"])
      )

    assert created.method == :patch
  end

  test "merge folds by the field's last-writer-wins rule" do
    table = unknown_type_index()

    [mutation] =
      RowMutations.fold(
        [
          component("u_low", "note_1", "note/title", :merge, leaf("low", 10)),
          component("u_high", "note_1", "note/title", :merge, leaf("high", 20))
        ],
        entity_types: table
      )

    assert mutation.data["fields"]["title"] == leaf("high", 20)
  end

  test "drop removes the field and leaves the row" do
    table = unknown_type_index()

    [mutation] =
      RowMutations.fold(
        [
          component("u1", "note_1", "note/title", :replace, leaf("t", 1)),
          component("u2", "note_1", "note/body", :drop, nil)
        ],
        entity_types: table
      )

    assert mutation.method == :put
    assert mutation.data == %{"fields" => %{"title" => leaf("t", 1)}}
  end

  test "any delete for the subject collapses the row to one delete" do
    table = unknown_type_index()

    [mutation] =
      RowMutations.fold(
        [
          component("u1", "note_1", "note/title", :replace, leaf("t", 1)),
          delete("u2", "note_1")
        ],
        entity_types: table,
        model_resolver: fn _id -> "note" end
      )

    assert %{method: :delete, data: nil, model: "note"} = mutation
    assert mutation.subject_id == "note_1"
  end

  test "a delete's model comes from the resolver, falling back to a sibling component" do
    table = unknown_type_index()

    [resolved] =
      RowMutations.fold([delete("u1", "rel_1")],
        entity_types: table,
        model_resolver: fn _id -> "relationship" end
      )

    assert resolved.model == "relationship"

    [from_sibling] =
      RowMutations.fold(
        [
          delete("u1", "rel_2"),
          component("u2", "rel_2", "relationship/source_id", :merge, leaf("note_1", 1))
        ],
        entity_types: table
      )

    assert from_sibling.model == "relationship"
  end

  # A fold with no existence signal would derive `:put` for every row, which
  # the rule engine reads as `<model>.create`; a fold with no committed-model
  # signal would forget the model a delete was authorized under. Both are the
  # caller's to provide, so neither may default silently.
  test "a fold without an existence signal raises" do
    assert_raise ArgumentError, ~r/needs an existence signal/, fn ->
      RowMutations.fold([component("u1", "note_1", "note/title", :replace, leaf("t", 1))])
    end
  end

  test "a fold without a committed-model signal raises" do
    assert_raise ArgumentError, ~r/needs a committed-model signal/, fn ->
      RowMutations.fold([delete("u1", "note_1")], exists?: fn _id -> true end)
    end
  end

  test "explicit predicates stand in for the index" do
    [mutation] =
      RowMutations.fold(
        [component("u1", "note_1", "note/title", :replace, leaf("t", 1))],
        exists?: fn _id -> true end,
        model_resolver: fn _id -> nil end
      )

    assert mutation.method == :patch
  end

  test "a delete's default model falls back to the by-id caches" do
    table = unknown_type_index()
    by_id = :"row_mutations_eg_by_id_#{System.unique_integer([:positive])}"
    :ets.new(by_id, [:set, :public, :named_table])

    :ets.insert(
      by_id,
      {"eg_1", %{id: "eg_1", entity_id: "note_1", group_id: "g_1"}}
    )

    # The type index knows nothing about the row — the lagging shape the
    # by-id caches exist for.
    [mutation] =
      RowMutations.fold([delete("u1", "eg_1")],
        entity_types: table,
        entity_groups_by_id: by_id
      )

    # A by-id cache row is a platform row, and every platform row is
    # committed under the one platform model.
    assert mutation.model == "ebb"
    assert mutation.method == :delete
  end

  test "the entity-type index is the default existence signal" do
    table = unknown_type_index()

    [unknown] =
      RowMutations.fold([component("u1", "note_1", "note/title", :replace, leaf("t", 1))],
        entity_types: table
      )

    :ets.insert(table, {"note_1", "note"})

    [known] =
      RowMutations.fold([component("u1", "note_1", "note/title", :replace, leaf("t", 1))],
        entity_types: table
      )

    assert unknown.method == :put
    assert known.method == :patch
  end
end
