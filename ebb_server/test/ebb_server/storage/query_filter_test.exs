defmodule EbbServer.Storage.QueryFilterTest do
  use ExUnit.Case, async: true

  alias EbbServer.Storage.QueryFilter

  describe "normalize/1" do
    test "treats nil and the empty map as unfiltered" do
      assert QueryFilter.normalize(nil) == {:ok, nil}
      assert QueryFilter.normalize(%{}) == {:ok, %{}}
    end

    test "accepts identifier-shaped keys with JSON scalar values" do
      filter = %{
        "title" => "Done task",
        "count" => 3,
        "ratio" => 1.5,
        "completed" => true,
        "missing" => nil
      }

      assert QueryFilter.normalize(filter) == {:ok, filter}
    end

    test "rejects a filter that is not a map" do
      for filter <- ["zzz", [1, 2], 1, true, :atom] do
        assert QueryFilter.normalize(filter) == {:error, :invalid_filter},
               "expected #{inspect(filter)} to be rejected"
      end
    end

    test "rejects keys that are not identifier-shaped strings" do
      for key <- ["a b", "", "1abc", "a-b", :title] do
        assert QueryFilter.normalize(%{key => "x"}) == {:error, :invalid_filter},
               "expected #{inspect(key)} to be rejected"
      end
    end

    test "rejects values that are not JSON scalars" do
      for value <- [%{"n" => 1}, [1, 2], {:ok, 1}] do
        assert QueryFilter.normalize(%{"title" => value}) == {:error, :invalid_filter},
               "expected #{inspect(value)} to be rejected"
      end
    end

    test "rejects integers SQLite cannot bind" do
      for value <- [9_223_372_036_854_775_808, -9_223_372_036_854_775_809] do
        assert QueryFilter.normalize(%{"count" => value}) == {:error, :invalid_filter},
               "expected #{inspect(value)} to be rejected"
      end

      for value <- [9_223_372_036_854_775_807, -9_223_372_036_854_775_808, 1.5] do
        assert QueryFilter.normalize(%{"count" => value}) == {:ok, %{"count" => value}}
      end
    end

    test "rejects more keys than the cap" do
      filter = for i <- 1..(QueryFilter.max_keys() + 1), into: %{}, do: {"field_#{i}", i}

      assert QueryFilter.normalize(filter) == {:error, :invalid_filter}
    end

    test "accepts a filter at the cap" do
      filter = for i <- 1..QueryFilter.max_keys(), into: %{}, do: {"field_#{i}", i}

      assert QueryFilter.normalize(filter) == {:ok, filter}
    end
  end
end
