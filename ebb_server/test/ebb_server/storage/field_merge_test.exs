defmodule EbbServer.Storage.FieldMergeTest do
  @moduledoc """
  Direct tests for the pure wire merge rule. No DB, no processes.

  `FieldMerge` hand-mirrors `packages/core/src/types/action.ts`'s
  `mergeFieldValue`; these cases pin the rule's behaviour on the Elixir
  side.
  """

  use ExUnit.Case, async: true

  alias EbbServer.Storage.FieldMerge

  defp leaf(value, hlc, update_id) do
    %{"value" => value, "hlc" => hlc, "update_id" => update_id}
  end

  defp bare_leaf(value, hlc), do: %{"value" => value, "hlc" => hlc}

  describe "merge/2 leaf over leaf" do
    test "higher incoming HLC wins" do
      existing = leaf("old", 1, "id-1")
      incoming = leaf("new", 2, "id-2")

      assert FieldMerge.merge(existing, incoming) == incoming
    end

    test "lower incoming HLC loses" do
      existing = leaf("old", 2, "id-1")
      incoming = leaf("new", 1, "id-2")

      assert FieldMerge.merge(existing, incoming) == existing
    end

    test "equal HLC breaks toward the greater incoming update_id" do
      existing = leaf("old", 5, "id-a")
      incoming = leaf("new", 5, "id-b")

      assert FieldMerge.merge(existing, incoming) == incoming
    end

    test "equal HLC breaks toward the greater existing update_id" do
      existing = leaf("old", 5, "id-b")
      incoming = leaf("new", 5, "id-a")

      assert FieldMerge.merge(existing, incoming) == existing
    end

    test "equal HLC and equal update_id keeps the incoming value" do
      existing = leaf("old", 5, "id-a")
      incoming = leaf("new", 5, "id-a")

      assert FieldMerge.merge(existing, incoming) == incoming
    end
  end

  describe "merge/2 nil existing" do
    test "returns the incoming value unchanged" do
      incoming = %{"map" => %{"a" => leaf("v", 1, "id-1")}}

      assert FieldMerge.merge(nil, incoming) == incoming
    end
  end

  describe "merge/2 map union" do
    test "unions disjoint keys" do
      existing = %{"map" => %{"a" => leaf("1", 1, "id-a")}}
      incoming = %{"map" => %{"b" => leaf("2", 2, "id-b")}}

      assert FieldMerge.merge(existing, incoming) == %{
               "map" => %{"a" => leaf("1", 1, "id-a"), "b" => leaf("2", 2, "id-b")}
             }
    end

    test "recurses on overlapping keys and leaves siblings untouched" do
      existing = %{"map" => %{"a" => leaf("old", 5, "id-a"), "b" => leaf("keep", 1, "id-b")}}
      incoming = %{"map" => %{"a" => leaf("new", 1, "id-c")}}

      assert FieldMerge.merge(existing, incoming) == existing
    end

    test "overlapping keys take the newer value" do
      existing = %{"map" => %{"a" => leaf("old", 1, "id-a")}}
      incoming = %{"map" => %{"a" => leaf("new", 2, "id-b")}}

      assert FieldMerge.merge(existing, incoming) == %{"map" => %{"a" => leaf("new", 2, "id-b")}}
    end

    test "unions nested maps" do
      existing = %{"map" => %{"outer" => %{"map" => %{"x" => leaf("1", 1, "id-a")}}}}
      incoming = %{"map" => %{"outer" => %{"map" => %{"y" => leaf("2", 2, "id-b")}}}}

      assert FieldMerge.merge(existing, incoming) == %{
               "map" => %{
                 "outer" => %{
                   "map" => %{"x" => leaf("1", 1, "id-a"), "y" => leaf("2", 2, "id-b")}
                 }
               }
             }
    end
  end

  describe "merge/2 kind mismatch" do
    test "leaf replaced by map returns the incoming map" do
      existing = leaf("v", 100, "id-a")
      incoming = %{"map" => %{"a" => leaf("v", 1, "id-b")}}

      assert FieldMerge.merge(existing, incoming) == incoming
    end

    test "map replaced by leaf returns the incoming leaf" do
      existing = %{"map" => %{"a" => leaf("v", 100, "id-a")}}
      incoming = leaf("v", 1, "id-b")

      assert FieldMerge.merge(existing, incoming) == incoming
    end
  end

  describe "merge/2 tombstone" do
    test "a null value participates as a normal leaf and can win" do
      existing = leaf("live", 1, "id-a")
      tombstone = leaf(nil, 2, "id-b")

      assert FieldMerge.merge(existing, tombstone) == tombstone
    end

    test "a later write can beat a tombstone" do
      tombstone = leaf(nil, 1, "id-a")
      incoming = leaf("live", 2, "id-b")

      assert FieldMerge.merge(tombstone, incoming) == incoming
    end
  end

  describe "merge/2 HLC representation" do
    test "decimal-string HLCs compare numerically" do
      existing = leaf("old", "9", "id-a")
      incoming = leaf("new", "10", "id-b")

      assert FieldMerge.merge(existing, incoming) == incoming
    end

    test "an integer and its decimal string order identically" do
      existing = leaf("old", 10, "id-a")
      incoming = leaf("new", "10", "id-b")

      assert FieldMerge.merge(existing, incoming) == incoming
    end
  end

  describe "stamp/2" do
    test "stamps a leaf that lacks an update_id" do
      field = bare_leaf(1, "1")

      assert FieldMerge.stamp(field, "upd_1") ==
               %{"value" => 1, "hlc" => "1", "update_id" => "upd_1"}
    end

    test "recurses into maps and stamps every leaf" do
      field = %{"map" => %{"a" => bare_leaf(1, "1"), "b" => bare_leaf(2, "2")}}

      assert FieldMerge.stamp(field, "upd_1") == %{
               "map" => %{
                 "a" => %{"value" => 1, "hlc" => "1", "update_id" => "upd_1"},
                 "b" => %{"value" => 2, "hlc" => "2", "update_id" => "upd_1"}
               }
             }
    end

    test "preserves an existing non-empty wire update_id" do
      field = %{"value" => 1, "hlc" => "1", "update_id" => "wire_id"}

      assert FieldMerge.stamp(field, "upd_1") == field
    end

    test "replaces an empty update_id with the update's id" do
      field = %{"value" => 1, "hlc" => "1", "update_id" => ""}

      assert FieldMerge.stamp(field, "upd_1") ==
               %{"value" => 1, "hlc" => "1", "update_id" => "upd_1"}
    end

    test "preserves nested wire update_ids while stamping their siblings" do
      field = %{
        "map" => %{
          "a" => %{"value" => 1, "update_id" => "wire_a"},
          "b" => bare_leaf(2, "2")
        }
      }

      assert FieldMerge.stamp(field, "upd_1") == %{
               "map" => %{
                 "a" => %{"value" => 1, "update_id" => "wire_a"},
                 "b" => %{"value" => 2, "hlc" => "2", "update_id" => "upd_1"}
               }
             }
    end
  end

  describe "compare_hlc/2" do
    test "orders integers" do
      assert FieldMerge.compare_hlc(2, 1) == :gt
      assert FieldMerge.compare_hlc(1, 2) == :lt
      assert FieldMerge.compare_hlc(1, 1) == :eq
    end

    test "treats an integer and its decimal string as equal" do
      assert FieldMerge.compare_hlc(10, "10") == :eq
      assert FieldMerge.compare_hlc("10", 10) == :eq
    end

    test "compares decimal strings numerically, not lexicographically" do
      assert FieldMerge.compare_hlc("10", "9") == :gt
      assert FieldMerge.compare_hlc("9", "10") == :lt
    end

    test "treats nil as zero" do
      assert FieldMerge.compare_hlc(nil, 0) == :eq
      assert FieldMerge.compare_hlc(nil, 1) == :lt
      assert FieldMerge.compare_hlc(1, nil) == :gt
      assert FieldMerge.compare_hlc(nil, nil) == :eq
    end

    test "treats unparseable values as zero" do
      assert FieldMerge.compare_hlc("nope", 0) == :eq
      assert FieldMerge.compare_hlc("12abc", 0) == :eq
      assert FieldMerge.compare_hlc(nil, "nope") == :eq
    end
  end
end
