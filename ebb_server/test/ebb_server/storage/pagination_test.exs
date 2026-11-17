defmodule EbbServer.Storage.PaginationTest do
  use ExUnit.Case, async: true

  alias EbbServer.Storage.Pagination

  describe "window" do
    test "defaults to 200 and caps at 1000" do
      assert Pagination.default_limit() == 200
      assert Pagination.max_limit() == 1000
    end
  end

  describe "normalize_limit/1" do
    test "an omitted limit becomes the default" do
      assert {:ok, 200} = Pagination.normalize_limit(nil)
      assert Pagination.normalize_limit(nil) == {:ok, Pagination.default_limit()}
    end

    test "accepts a positive integer up to the cap" do
      assert Pagination.normalize_limit(1) == {:ok, 1}
      assert Pagination.normalize_limit(200) == {:ok, 200}
      assert Pagination.normalize_limit(999) == {:ok, 999}
      assert Pagination.normalize_limit(1000) == {:ok, 1000}
    end

    test "rejects anything past the cap" do
      assert Pagination.normalize_limit(1001) == {:error, :invalid_limit}
      assert Pagination.normalize_limit(Pagination.max_limit() + 1) == {:error, :invalid_limit}
    end

    test "rejects zero and negative limits" do
      assert Pagination.normalize_limit(0) == {:error, :invalid_limit}
      assert Pagination.normalize_limit(-1) == {:error, :invalid_limit}
    end

    test "rejects a limit that is not an integer" do
      for value <- ["200", 200.0, :all, %{}, [200]] do
        assert Pagination.normalize_limit(value) == {:error, :invalid_limit},
               "expected #{inspect(value)} to be rejected"
      end
    end
  end
end
