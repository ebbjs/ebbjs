defmodule EbbServer.Storage.EntityViewComponentsTest do
  use ExUnit.Case, async: true

  alias EbbServer.Storage.EntityView

  defp view(type, fields) do
    %{
      "id" => "note_1",
      "type" => type,
      "data" => %{"fields" => fields},
      "created_hlc" => 1,
      "updated_hlc" => 2,
      "deleted_hlc" => nil,
      "last_gsn" => 3
    }
  end

  test "an omitted component list is the whole row" do
    row = view("note", %{"title" => 1, "body" => 2})
    assert EntityView.filter_components(row, nil) == row
  end

  test "only the requested components' fields survive" do
    row = view("note", %{"title" => 1, "body" => 2})

    assert EntityView.filter_components(row, MapSet.new(["note/title"]))["data"] == %{
             "fields" => %{"title" => 1}
           }
  end

  test "a component of another model cannot address a same-named field" do
    row = view("note", %{"title" => 1})

    assert EntityView.filter_components(row, MapSet.new(["other/title"]))["data"] == %{
             "fields" => %{}
           }
  end

  test "unknown component names are ignored" do
    row = view("note", %{"title" => 1, "body" => 2})

    assert EntityView.filter_components(row, MapSet.new(["note/title", "note/missing"]))[
             "data"
           ] == %{"fields" => %{"title" => 1}}
  end

  test "the rest of the row is untouched" do
    row = view("note", %{"title" => 1, "body" => 2})
    filtered = EntityView.filter_components(row, MapSet.new(["note/title"]))

    assert Map.drop(filtered, ["data"]) == Map.drop(row, ["data"])
  end

  test "json/1 hides the read model's derived components key" do
    entity = %{
      id: "note_1",
      type: "note",
      data: %{"fields" => %{"title" => 1}, "components" => ["note/title"]},
      created_hlc: 1,
      updated_hlc: 2,
      deleted_hlc: nil,
      last_gsn: 3
    }

    assert EntityView.json(entity)["data"] == %{"fields" => %{"title" => 1}}

    assert EntityView.filter_components(EntityView.json(entity), nil)["data"] == %{
             "fields" => %{"title" => 1}
           }
  end

  test "nil and filtered projections strip a derived components key from a raw view" do
    view = %{
      "id" => "note_1",
      "type" => "note",
      "data" => %{"fields" => %{"title" => 1}, "components" => ["note/title"]}
    }

    assert EntityView.filter_components(view, nil)["data"] == %{"fields" => %{"title" => 1}}

    assert EntityView.filter_components(view, MapSet.new(["note/title"]))["data"] == %{
             "fields" => %{"title" => 1}
           }
  end
end
