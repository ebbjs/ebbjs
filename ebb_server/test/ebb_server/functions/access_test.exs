defmodule EbbServer.Functions.AccessTest do
  use ExUnit.Case, async: true

  alias EbbServer.Functions.Access

  setup do
    table = :"functions_access_test_#{System.unique_integer([:positive])}"
    # The test process owns the table, so it disappears with the test.
    :ets.new(table, [:bag, :public, :named_table])
    %{table: table}
  end

  describe "permission-gated access" do
    test "function.<name> on any membership grants the invocation", %{table: table} do
      grant(table, "a_test", "g_1", ["doc.read", "function.proofreadDocument"])

      assert :ok = Access.authorize("granted", "a_test", "proofreadDocument", table: table)
    end

    test "function.* grants every function", %{table: table} do
      grant(table, "a_test", "g_1", ["function.*"])

      assert :ok = Access.authorize("granted", "a_test", "proofreadDocument", table: table)
      assert :ok = Access.authorize("granted", "a_test", "someOtherFunction", table: table)
    end

    test "a grant on the second of several memberships still grants", %{table: table} do
      grant(table, "a_test", "g_1", ["doc.read"])
      grant(table, "a_test", "g_2", ["function.proofreadDocument"])

      assert :ok = Access.authorize("granted", "a_test", "proofreadDocument", table: table)
    end

    test "a grant for a different function is denied", %{table: table} do
      grant(table, "a_test", "g_1", ["function.otherFunction"])

      assert {:error, :denied} =
               Access.authorize("granted", "a_test", "proofreadDocument", table: table)
    end

    test "an empty permission list is denied", %{table: table} do
      grant(table, "a_test", "g_1", [])

      assert {:error, :denied} =
               Access.authorize("granted", "a_test", "proofreadDocument", table: table)
    end

    test "a membership without permissions is denied", %{table: table} do
      grant(table, "a_test", "g_1", nil)

      assert {:error, :denied} =
               Access.authorize("granted", "a_test", "proofreadDocument", table: table)
    end

    test "a non-member is denied", %{table: table} do
      grant(table, "a_other", "g_1", ["function.*"])

      assert {:error, :denied} =
               Access.authorize("granted", "a_test", "proofreadDocument", table: table)
    end

    test "a non-permission grant is not a function grant", %{table: table} do
      grant(table, "a_test", "g_1", ["doc.read", "function", "*"])

      assert {:error, :denied} =
               Access.authorize("granted", "a_test", "proofreadDocument", table: table)
    end

    test "grants match literally, without case folding", %{table: table} do
      grant(table, "a_test", "g_1", ["function.proofreaddocument"])

      assert {:error, :denied} =
               Access.authorize("granted", "a_test", "proofreadDocument", table: table)
    end

    test "a grant read from another table does not leak in", %{table: table} do
      other = :"functions_access_other_#{System.unique_integer([:positive])}"
      :ets.new(other, [:bag, :public, :named_table])
      grant(other, "a_test", "g_1", ["function.*"])

      assert {:error, :denied} =
               Access.authorize("granted", "a_test", "proofreadDocument", table: table)
    end
  end

  describe "authenticated access" do
    test "passes without a grant", %{table: table} do
      assert :ok = Access.authorize("authenticated", "a_test", "proofreadDocument", table: table)
    end

    test "is denied for a nil actor", %{table: table} do
      assert {:error, :denied} =
               Access.authorize("authenticated", nil, "proofreadDocument", table: table)
    end

    test "is denied for an empty actor", %{table: table} do
      assert {:error, :denied} =
               Access.authorize("authenticated", "", "proofreadDocument", table: table)
    end

    test "ignores grants for other actors", %{table: table} do
      grant(table, "a_other", "g_1", ["function.*"])

      assert :ok = Access.authorize("authenticated", "a_test", "proofreadDocument", table: table)
    end
  end

  describe "unresolved principals" do
    test "a nil actor is denied even with a grant", %{table: table} do
      grant(table, "a_test", "g_1", ["function.*"])

      assert {:error, :denied} =
               Access.authorize("granted", nil, "proofreadDocument", table: table)
    end

    test "an empty actor is denied even with a grant", %{table: table} do
      grant(table, "a_test", "g_1", ["function.*"])

      assert {:error, :denied} =
               Access.authorize("granted", "", "proofreadDocument", table: table)
    end
  end

  describe "unrecognized access values" do
    test "a missing access value fails closed even with a grant", %{table: table} do
      grant(table, "a_test", "g_1", ["function.*"])

      assert {:error, :denied} =
               Access.authorize(nil, "a_test", "proofreadDocument", table: table)
    end

    test "an unknown access value fails closed even with a grant", %{table: table} do
      grant(table, "a_test", "g_1", ["function.*"])

      assert {:error, :denied} =
               Access.authorize("public", "a_test", "proofreadDocument", table: table)
    end
  end

  describe "name grammar" do
    test "a 64-character identifier is accepted", %{table: table} do
      grant(table, "a_test", "g_1", ["function.*"])
      name = String.duplicate("a", 64)

      assert :ok = Access.authorize("granted", "a_test", name, table: table)
    end

    test "underscores are part of the name grammar and hyphens are not", %{table: table} do
      grant(table, "a_test", "g_1", ["function.*"])

      assert :ok = Access.authorize("granted", "a_test", "under_score", table: table)
      assert :ok = Access.authorize("granted", "a_test", "_leading", table: table)

      assert {:error, :denied} =
               Access.authorize("granted", "a_test", "with-hyphen", table: table)
    end

    for name <- [
          "",
          "with.dot",
          "with space",
          "1leading",
          "default",
          "wild*",
          String.duplicate("a", 65),
          nil,
          :atom
        ] do
      test "#{inspect(name)} is denied for authenticated access", %{table: table} do
        assert {:error, :denied} =
                 Access.authorize("authenticated", "a_test", unquote(name), table: table)
      end
    end
  end

  defp grant(table, actor_id, group_id, permissions) do
    entry = %{
      id: "gm_#{actor_id}_#{group_id}",
      actor_id: actor_id,
      group_id: group_id,
      permissions: permissions
    }

    :ets.insert(table, {actor_id, entry})
    :ok
  end
end
