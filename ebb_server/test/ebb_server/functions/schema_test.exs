defmodule EbbServer.Functions.SchemaTest do
  use ExUnit.Case, async: true

  alias EbbServer.Functions.Schema

  describe "resolve/2" do
    test "nil is the absence of a schema, not an error" do
      assert Schema.resolve(nil, "paramsSchema") == {:ok, nil, nil}
    end

    test "keeps the raw boolean schema beside its resolved root" do
      assert {:ok, true, %ExJsonSchema.Schema.Root{schema: true}} =
               Schema.resolve(true, "outputSchema")
    end

    test "keeps the raw map beside its resolved root" do
      schema = %{"type" => "object", "required" => ["text"]}

      assert {:ok, ^schema, %ExJsonSchema.Schema.Root{schema: ^schema}} =
               Schema.resolve(schema, "paramsSchema")
    end

    test "an unresolvable schema is the field's error" do
      assert {:error, {:invalid_schema, "paramsSchema", reason}} =
               Schema.resolve(%{"type" => "nonsense"}, "paramsSchema")

      assert is_binary(reason) and reason != ""
    end

    test "a value that is neither an object nor a boolean is refused" do
      for value <- ["object", 42, [%{"type" => "object"}]] do
        assert Schema.resolve(value, "paramsSchema") ==
                 {:error,
                  {:invalid_schema, "paramsSchema", "schema must be a JSON object or boolean"}}
      end
    end
  end

  describe "validate/2" do
    test "answers yes for a resolvable schema and the error otherwise" do
      assert Schema.validate(%{"type" => "object"}, "paramsSchema") == :ok
      assert Schema.validate(nil, "paramsSchema") == :ok
      assert Schema.validate(false, "outputSchema") == :ok

      assert {:error, {:invalid_schema, "outputSchema", _reason}} =
               Schema.validate(%{"$ref" => "#/definitions/missing"}, "outputSchema")
    end
  end

  describe "validate_text/2" do
    test "nil is still the absence of a schema" do
      assert Schema.validate_text(nil, "paramsSchema") == :ok
    end

    test "decodes stored JSON before resolving it" do
      assert Schema.validate_text(~s({"type":"object"}), "paramsSchema") == :ok

      assert {:error, {:invalid_schema, "paramsSchema", reason}} =
               Schema.validate_text(~s({"type":"nonsense"}), "paramsSchema")

      assert is_binary(reason) and reason != ""
    end

    test "corrupted JSON is an invalid schema, not an absent one" do
      assert {:error, {:invalid_schema, "paramsSchema", details}} =
               Schema.validate_text("{not json", "paramsSchema")

      assert details =~ "invalid JSON"
    end

    test "a non-text value is refused" do
      assert Schema.validate_text(42, "paramsSchema") ==
               {:error, {:invalid_schema, "paramsSchema", "schema must be JSON text"}}
    end
  end
end
