defmodule EbbServer.Storage.QueryFilterTest do
  use ExUnit.Case, async: true

  alias EbbServer.Storage.QueryFilter

  describe "normalize/1" do
    test "treats nil and the empty list as unfiltered" do
      assert QueryFilter.normalize(nil) == {:ok, nil}
      assert QueryFilter.normalize([]) == {:ok, nil}
    end

    test "treats any empty group as unfiltered" do
      assert QueryFilter.normalize([%{}]) == {:ok, nil}
      assert QueryFilter.normalize([%{}, %{"title" => "x"}]) == {:ok, nil}
    end

    test "accepts identifier-shaped keys with JSON scalar values" do
      group = %{
        "title" => "Done task",
        "count" => 3,
        "ratio" => 1.5,
        "completed" => true,
        "missing" => nil
      }

      assert QueryFilter.normalize([group]) == {:ok, [group]}
    end

    test "accepts several groups as a disjunction" do
      groups = [%{"priority" => "normal"}, %{"priority" => nil}]

      assert QueryFilter.normalize(groups) == {:ok, groups}
    end

    test "rejects a nil entry where a group is expected" do
      assert QueryFilter.normalize([nil]) == {:error, :invalid_filter}
      assert QueryFilter.normalize([%{"title" => "x"}, nil]) == {:error, :invalid_filter}
    end

    test "rejects a filter that is not a list of maps" do
      filters = ["zzz", %{"title" => "x"}, 1, true, :atom, [1], [%{"title" => "x"}, []]]

      for filter <- filters do
        assert QueryFilter.normalize(filter) == {:error, :invalid_filter},
               "expected #{inspect(filter)} to be rejected"
      end
    end

    test "rejects keys that are not identifier-shaped strings" do
      for key <- ["a b", "", "1abc", "a-b", :title] do
        assert QueryFilter.normalize([%{key => "x"}]) == {:error, :invalid_filter},
               "expected #{inspect(key)} to be rejected"
      end
    end

    test "rejects values that are not JSON scalars" do
      for value <- [%{"n" => 1}, [1, 2], {:ok, 1}] do
        assert QueryFilter.normalize([%{"title" => value}]) == {:error, :invalid_filter},
               "expected #{inspect(value)} to be rejected"
      end
    end

    test "rejects integers SQLite cannot bind" do
      for value <- [9_223_372_036_854_775_808, -9_223_372_036_854_775_809] do
        assert QueryFilter.normalize([%{"count" => value}]) == {:error, :invalid_filter},
               "expected #{inspect(value)} to be rejected"
      end

      for value <- [9_223_372_036_854_775_807, -9_223_372_036_854_775_808, 1.5] do
        assert QueryFilter.normalize([%{"count" => value}]) == {:ok, [%{"count" => value}]}
      end
    end

    test "rejects more keys than the cap in one group" do
      group = for i <- 1..(QueryFilter.max_keys() + 1), into: %{}, do: {"field_#{i}", i}

      assert QueryFilter.normalize([group]) == {:error, :invalid_filter}
    end

    test "accepts a group at the cap" do
      group = for i <- 1..QueryFilter.max_keys(), into: %{}, do: {"field_#{i}", i}

      assert QueryFilter.normalize([group]) == {:ok, [group]}
    end

    test "applies the cap per group, not across the filter" do
      group = for i <- 1..QueryFilter.max_keys(), into: %{}, do: {"field_#{i}", i}

      assert QueryFilter.normalize([group, group]) == {:ok, [group, group]}
    end
  end
end
