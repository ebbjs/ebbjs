defmodule EbbServer.Functions.ValidateTest do
  use ExUnit.Case, async: true

  alias EbbServer.Functions.Bundle
  alias EbbServer.Functions.Validate
  alias EbbServer.TestFunctions.Bundles

  defp bundle(params_schema \\ nil, output_schema \\ nil) do
    overrides = %{"paramsSchema" => params_schema, "outputSchema" => output_schema}

    {:ok, bundle} =
      "proofreadDocument"
      |> Bundles.envelope(overrides)
      |> Bundle.new(Bundles.code())

    bundle
  end

  describe "params/2" do
    test "accepts anything when the bundle declares no params schema" do
      assert :ok = Validate.params(bundle(), %{"anything" => ["at", "all"]})
      assert :ok = Validate.params(bundle(), nil)
      assert :ok = Validate.params(bundle(), "not even an object")
    end

    test "accepts data that matches the schema" do
      bundle =
        bundle(%{
          "type" => "object",
          "properties" => %{"documentId" => %{"type" => "string"}},
          "required" => ["documentId"]
        })

      assert :ok = Validate.params(bundle, %{"documentId" => "doc_1"})
    end

    test "reports a missing required property at the root" do
      bundle = bundle(%{"type" => "object", "required" => ["documentId"]})

      assert {:error, [issue]} = Validate.params(bundle, %{})

      assert %{"path" => "", "message" => message} = issue
      assert is_binary(message) and message =~ "documentId"
    end

    test "reports a wrong type with its property as the path" do
      bundle =
        bundle(%{
          "type" => "object",
          "properties" => %{"documentId" => %{"type" => "string"}}
        })

      assert {:error, [issue]} = Validate.params(bundle, %{"documentId" => 42})

      assert %{"path" => "documentId", "message" => message} = issue
      assert is_binary(message) and message != ""
    end

    test "dotted paths index into arrays" do
      bundle =
        bundle(%{
          "type" => "object",
          "properties" => %{
            "items" => %{
              "type" => "array",
              "items" => %{
                "type" => "object",
                "properties" => %{"name" => %{"type" => "string"}},
                "required" => ["name"]
              }
            }
          }
        })

      assert {:error, [issue]} = Validate.params(bundle, %{"items" => [%{"name" => 42}]})

      assert %{"path" => "items[0].name", "message" => message} = issue
      assert is_binary(message) and message != ""
    end

    test "caps the number of issues it returns" do
      bundle =
        bundle(%{"type" => "array", "items" => %{"type" => "string"}})

      assert {:error, issues} = Validate.params(bundle, Enum.to_list(1..15))
      assert length(issues) == 10
      assert Enum.map(issues, & &1["path"]) == Enum.map(0..9, &"[#{&1}]")
    end
  end

  describe "output/2" do
    test "accepts anything when the bundle declares no output schema" do
      assert :ok = Validate.output(bundle(), %{"anything" => true})
      assert :ok = Validate.output(bundle(), nil)
    end

    test "accepts a result that matches the schema" do
      bundle =
        bundle(nil, %{
          "type" => "object",
          "properties" => %{"proofread" => %{"type" => "boolean"}},
          "required" => ["proofread"]
        })

      assert :ok = Validate.output(bundle, %{"proofread" => true})
    end

    test "reports a result that does not match the schema" do
      bundle =
        bundle(nil, %{
          "type" => "object",
          "properties" => %{"proofread" => %{"type" => "boolean"}},
          "required" => ["proofread"]
        })

      assert {:error, [issue]} = Validate.output(bundle, %{"proofread" => "yes"})

      assert %{"path" => "proofread", "message" => message} = issue
      assert is_binary(message) and message != ""
    end
  end
end
