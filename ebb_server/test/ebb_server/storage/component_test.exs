defmodule EbbServer.Storage.ComponentTest do
  @moduledoc """
  Pins the one definition of a component name.

  Every module that reads a component's model or field goes through
  `EbbServer.Storage.Component`, so a name the validator accepts and a name
  this module splits must be the same set: a disagreement would let a
  component through validation and crash materialization.
  """

  use ExUnit.Case, async: true

  alias EbbServer.Storage.Component

  test "splits a well-formed name into model and field" do
    assert Component.split("note/title") == {"note", "title"}
    assert Component.model("entityGroup/group_id") == "entityGroup"
    assert Component.field("entityGroup/group_id") == "group_id"
  end

  test "a name is exactly one slash with both segments non-empty" do
    for component <- ["note/title", "ebb/link", "a/b"] do
      assert Component.valid?(component)
    end

    for component <- ["note", "/title", "note/", "note/ti/tle", "a/b/c/d", "", nil, 42] do
      refute Component.valid?(component)
    end
  end

  test "splitting a malformed name raises rather than guessing" do
    # Only the validator turns a bad name into a rejection; every other caller
    # reads a name validation or a frame decode already accepted.
    for component <- ["note", "note/ti/tle", nil] do
      assert_raise ArgumentError, ~r/<model>\/<field>/, fn -> Component.split(component) end
    end
  end

  test "the method set is the envelope's, in one place" do
    assert Component.method_names() == ["merge", "replace", "drop", "delete"]

    for method <- Component.method_names() do
      assert Component.method?(method)
      assert Component.method_string(Component.to_method(method)) == method
    end

    refute Component.method?("put")
    refute Component.method?("patch")
    assert_raise ArgumentError, fn -> Component.to_method("put") end
  end

  test "the update key set is the envelope's" do
    assert Component.update_keys() == ["id", "subject_id", "component", "method", "data"]
  end
end
