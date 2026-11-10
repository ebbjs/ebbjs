defmodule EbbServer.Bench.ComponentsTest do
  @moduledoc """
  Pins what `mix bench.components` measures, so the payload delta the epic
  records cannot drift silently when the envelope changes.
  """

  use ExUnit.Case, async: true

  alias EbbServer.Bench.Components
  alias EbbServer.Storage.ActionValidator

  test "one logical edit is one Update per component" do
    action = Components.component_action()

    assert Enum.map(action["updates"], & &1["component"]) == Components.components()
    assert length(action["updates"]) == 5
    assert Enum.all?(action["updates"], &(&1["method"] == "merge"))
  end

  test "the component shape is a valid Action and the row-record shape is not" do
    assert :ok = ActionValidator.validate_structure(Components.component_action())

    assert {:error, "invalid_structure", details} =
             ActionValidator.validate_structure(Components.row_action())

    assert details =~ "unknown keys"
  end

  test "the report prices the growth: more Updates, larger payload" do
    report = Components.report()

    assert report.old_updates == 1
    assert report.new_updates == 5
    assert report.new_stored_bytes > report.old_stored_bytes
    assert report.new_json_bytes > report.old_json_bytes
  end
end
