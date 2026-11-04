defmodule EbbServer.Functions.BundleTest do
  use ExUnit.Case, async: true

  alias EbbServer.Functions.Bundle
  alias EbbServer.TestFunctions.Bundles

  @code Bundles.code()
  @digest Bundles.envelope("proofreadDocument")["digest"]

  defp envelope(overrides \\ %{}), do: Bundles.envelope("proofreadDocument", overrides)

  describe "new/2" do
    test "builds a bundle from a decoded envelope and its code" do
      assert {:ok, bundle} = Bundle.new(envelope(), @code)

      assert %Bundle{
               name: "proofreadDocument",
               version: "1.0.0",
               digest: @digest,
               runtime: "bun",
               contract: 1,
               access: "granted",
               timeout_ms: 30_000,
               memory_bytes: 268_435_456,
               entry: "proofreadDocument",
               params_schema: nil,
               output_schema: nil,
               resolved_params_schema: nil,
               resolved_output_schema: nil,
               code: @code
             } = bundle
    end

    test "keeps the optional schemas exactly as the envelope carried them" do
      params_schema = %{"type" => "object", "required" => ["documentId"]}
      output_schema = %{"type" => "object", "$defs" => %{"comment" => %{"type" => "string"}}}

      bundle =
        envelope(%{"paramsSchema" => params_schema, "outputSchema" => output_schema})
        |> Bundle.new(@code)
        |> elem(1)

      assert bundle.params_schema == params_schema
      assert bundle.output_schema == output_schema
    end

    test "resolves each schema exactly once, keeping the raw map beside it" do
      params_schema = %{
        "type" => "object",
        "properties" => %{"documentId" => %{"type" => "string"}},
        "required" => ["documentId"]
      }

      output_schema = %{"type" => "object", "$defs" => %{"comment" => %{"type" => "string"}}}

      assert {:ok, bundle} =
               envelope(%{"paramsSchema" => params_schema, "outputSchema" => output_schema})
               |> Bundle.new(@code)

      assert bundle.params_schema == params_schema
      assert bundle.output_schema == output_schema
      assert %ExJsonSchema.Schema.Root{} = bundle.resolved_params_schema
      assert %ExJsonSchema.Schema.Root{} = bundle.resolved_output_schema
      assert bundle.resolved_params_schema.schema == params_schema
      assert bundle.resolved_output_schema.schema == output_schema
    end

    test "ignores fields it does not know, so a signature can arrive in #597" do
      assert {:ok, %Bundle{}} =
               envelope(%{"signature" => "ed25519:abc", "signerKeyId" => "k_1"})
               |> Bundle.new(@code)
    end

    test "refuses a non-map envelope and non-binary code" do
      assert {:error, {:invalid_field, "envelope"}} = Bundle.new("not a map", @code)
      assert {:error, {:invalid_field, "code"}} = Bundle.new(envelope(), :not_a_binary)
    end
  end

  describe "schemas" do
    test "refuses a params schema that cannot be resolved" do
      for schema <- [%{"type" => "nonsense"}, %{"$ref" => "#/definitions/missing"}] do
        assert {:error, {:invalid_schema, "paramsSchema", reason}} =
                 Bundle.new(envelope(%{"paramsSchema" => schema}), @code)

        assert is_binary(reason) and reason != ""
      end
    end

    test "refuses an output schema that cannot be resolved" do
      for schema <- [%{"type" => "nonsense"}, %{"$ref" => "#/definitions/missing"}] do
        assert {:error, {:invalid_schema, "outputSchema", reason}} =
                 Bundle.new(envelope(%{"outputSchema" => schema}), @code)

        assert is_binary(reason) and reason != ""
      end
    end

    test "refuses a schema that is neither an object nor a boolean" do
      for schema <- ["object", 42, [%{"type" => "object"}]] do
        assert {:error,
                {:invalid_schema, "paramsSchema", "schema must be a JSON object or boolean"}} =
                 Bundle.new(envelope(%{"paramsSchema" => schema}), @code)

        assert {:error,
                {:invalid_schema, "outputSchema", "schema must be a JSON object or boolean"}} =
                 Bundle.new(envelope(%{"outputSchema" => schema}), @code)
      end
    end

    test "accepts a boolean schema, as draft-7 allows" do
      assert {:ok, bundle} = Bundle.new(envelope(%{"paramsSchema" => true}), @code)
      assert bundle.params_schema == true
      assert %ExJsonSchema.Schema.Root{schema: true} = bundle.resolved_params_schema

      assert {:ok, bundle} = Bundle.new(envelope(%{"outputSchema" => false}), @code)
      assert bundle.output_schema == false
      assert %ExJsonSchema.Schema.Root{schema: false} = bundle.resolved_output_schema
    end
  end

  describe "digest" do
    test "digest_for/1 is the lowercase hex sha256 of the code, canonicalised" do
      # Known-good literal: sha256("abc").
      assert Bundle.digest_for("abc") ==
               "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    end

    test "refuses a code digest that is not the envelope's" do
      envelope = envelope(%{"digest" => Bundle.digest_for("some other code")})

      assert {:error, :digest_mismatch} = Bundle.new(envelope, @code)
    end

    test "refuses a digest that is not in the canonical form" do
      [
        :crypto.hash(:sha256, @code) |> Base.encode16(case: :lower) |> String.upcase(),
        "sha256:fixture",
        "sha256:" <> String.slice(String.trim_leading(@digest, "sha256:"), 0, 16),
        "sha512:" <> String.trim_leading(@digest, "sha256:"),
        String.trim_leading(@digest, "sha256:"),
        Base.encode16(:crypto.hash(:sha256, @code), case: :lower)
      ]
      |> Enum.each(fn digest ->
        assert {:error, :digest_mismatch} = Bundle.new(envelope(%{"digest" => digest}), @code)
      end)
    end
  end

  describe "required envelope fields" do
    test "refuses an envelope missing any required field" do
      for field <- ~w(name version digest runtime contract access timeoutMs memoryBytes entry) do
        assert {:error, {:missing_field, ^field}} =
                 Bundle.new(Map.delete(envelope(), field), @code)
      end
    end

    test "treats a null field as missing" do
      assert {:error, {:missing_field, "version"}} =
               Bundle.new(envelope(%{"version" => nil}), @code)
    end
  end

  describe "the name grammar" do
    test "accepts a function name up to 64 characters" do
      for name <- ["a", "A1_b2", "_internal", "proofreadDocument", String.duplicate("a", 64)] do
        assert {:ok, %Bundle{name: ^name}} =
                 Bundles.envelope(name, %{"entry" => name}) |> Bundle.new(@code)
      end
    end

    test "refuses anything outside the name grammar" do
      for name <- [
            "",
            "1abc",
            "create-todo",
            "a.b",
            "a b",
            "a/b",
            "a@1.0.0",
            "a$",
            String.duplicate("a", 65),
            :atom,
            42
          ] do
        assert {:error, {:invalid_name, _}} = Bundle.new(envelope(%{"name" => name}), @code),
               "expected #{inspect(name)} to be refused"
      end
    end

    test "refuses the reserved binding name" do
      assert {:error, {:invalid_name, "default"}} =
               Bundle.new(envelope(%{"name" => "default"}), @code)
    end
  end

  describe "limits" do
    test "refuses a timeout or memory budget that is not a positive integer" do
      for {field, value} <- [
            {"timeoutMs", 0},
            {"timeoutMs", -1},
            {"timeoutMs", 1.5},
            {"timeoutMs", "30000"},
            {"memoryBytes", 0},
            {"memoryBytes", -1024},
            {"memoryBytes", "268435456"}
          ] do
        assert {:error, {:missing_field, ^field}} = Bundle.new(envelope(%{field => nil}), @code)
        assert {:error, {:invalid_field, ^field}} = Bundle.new(envelope(%{field => value}), @code)
      end
    end
  end

  describe "the wall-clock limit" do
    test "accepts the documented maximum and refuses more" do
      assert {:ok, %Bundle{timeout_ms: 60_000}} =
               envelope(%{"timeoutMs" => 60_000}) |> Bundle.new(@code)

      assert {:error, {:invalid_field, "timeoutMs"}} =
               Bundle.new(envelope(%{"timeoutMs" => 60_001}), @code)
    end
  end

  describe "access" do
    test "accepts the two declared access modes" do
      for access <- ["granted", "authenticated"] do
        assert {:ok, %Bundle{access: ^access}} =
                 envelope(%{"access" => access}) |> Bundle.new(@code)
      end
    end

    test "refuses any other access mode" do
      for access <- ["public", "Granted", true, 1] do
        assert {:error, {:invalid_field, "access"}} =
                 Bundle.new(envelope(%{"access" => access}), @code)
      end
    end
  end

  describe "contract" do
    test "accepts the contract this server speaks" do
      assert {:ok, %Bundle{contract: contract}} = Bundle.new(envelope(), @code)
      assert contract == Bundle.contract_version()
    end

    test "refuses a bundle built against a newer contract" do
      assert {:error, {:unsupported_contract, 2}} =
               Bundle.new(envelope(%{"contract" => 2}), @code)
    end

    test "refuses a contract that is not a positive integer" do
      for contract <- [0, -1, "1", 1.0] do
        assert {:error, {:invalid_field, "contract"}} =
                 Bundle.new(envelope(%{"contract" => contract}), @code)
      end
    end
  end

  describe "string fields" do
    test "refuses an empty or non-string version, runtime, or entry" do
      for field <- ~w(version runtime entry), value <- ["", :atom, 1, %{}] do
        assert {:error, {:invalid_field, ^field}} =
                 Bundle.new(envelope(%{field => value}), @code),
               "expected #{field}=#{inspect(value)} to be refused"
      end
    end
  end
end
