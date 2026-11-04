defmodule EbbServer.Functions.Bundle.StoreLoaderTest do
  use ExUnit.Case, async: false

  alias EbbServer.Functions.Bundle
  alias EbbServer.Functions.Bundle.StoreLoader
  alias EbbServer.Functions.BundleCache
  alias EbbServer.Functions.Store
  alias EbbServer.TestHelpers

  @name "addNumbers"
  @code "export const addNumbers = (params) => params.a + params.b;\n"

  @params_schema %{
    "type" => "object",
    "properties" => %{"a" => %{"type" => "number"}, "b" => %{"type" => "number"}}
  }
  @output_schema %{"type" => "number"}

  setup context do
    %{data_dir: TestHelpers.tmp_dir(context)}
  end

  defp start_store(%{data_dir: data_dir}) do
    start_supervised!(
      Supervisor.child_spec({Store, name: nil, data_dir: data_dir}, id: make_ref())
    )
  end

  defp start_stopped_store(%{data_dir: data_dir}) do
    store =
      start_supervised!(
        Supervisor.child_spec(
          {Store, name: nil, data_dir: data_dir},
          id: make_ref(),
          restart: :temporary
        )
      )

    :ok = GenServer.stop(store)
    store
  end

  defp start_cache(store) do
    start_supervised!(
      Supervisor.child_spec(
        {BundleCache, name: nil, loader: StoreLoader, loader_opts: [store: store]},
        id: make_ref()
      )
    )
  end

  defp attrs(overrides) do
    Map.merge(
      %{
        name: @name,
        version: "1.0.0",
        code: @code,
        digest: Bundle.digest_for(@code),
        runtime: "bun",
        entry: @name,
        access: "granted",
        contract: 1,
        timeout_ms: 5_000,
        memory_bytes: 64 * 1024 * 1024,
        params_schema: @params_schema,
        output_schema: @output_schema
      },
      overrides
    )
  end

  defp put!(store, overrides \\ %{}) do
    assert {:ok, version} = Store.put_version(attrs(overrides), store)
    version
  end

  defp deploy!(store, overrides \\ %{}) do
    version = put!(store, overrides)
    assert {:ok, _activated} = Store.activate(version.name, version.version, store)
    version
  end

  describe "load/2" do
    test "serves the active version as the envelope DirLoader would, plus its code", context do
      store = start_store(context)
      deploy!(store)

      assert {:ok, envelope, code} = StoreLoader.load(@name, store: store)

      assert code == @code

      # Exactly the envelope shape a directory loader answers: camelCase, an
      # integer contract, integer limits, decoded schemas, and no `code`.
      assert envelope == %{
               "name" => @name,
               "version" => "1.0.0",
               "digest" => Bundle.digest_for(@code),
               "runtime" => "bun",
               "contract" => 1,
               "access" => "granted",
               "timeoutMs" => 5_000,
               "memoryBytes" => 64 * 1024 * 1024,
               "entry" => @name,
               "paramsSchema" => @params_schema,
               "outputSchema" => @output_schema
             }
    end

    test "omits the schema keys when the version declared none", context do
      store = start_store(context)
      deploy!(store, %{params_schema: nil, output_schema: nil})

      assert {:ok, envelope, _code} = StoreLoader.load(@name, store: store)

      refute Map.has_key?(envelope, "paramsSchema")
      refute Map.has_key?(envelope, "outputSchema")
    end

    test "does not serve a version that was stored but never activated", context do
      store = start_store(context)
      put!(store)

      assert :not_found = StoreLoader.load(@name, store: store)
    end

    test "a disabled name reads as undeployed", context do
      store = start_store(context)
      deploy!(store)
      assert {:ok, _disabled} = Store.disable(@name, store)

      assert :not_found = StoreLoader.load(@name, store: store)
    end

    test "a store that cannot answer is an error, never a miss", context do
      store = start_stopped_store(context)

      assert {:error, {:store_unavailable, _reason}} = StoreLoader.load(@name, store: store)
    end
  end

  describe "through BundleCache" do
    test "an activated version becomes a bundle with its schemas resolved once", context do
      store = start_store(context)
      deploy!(store)
      cache = start_cache(store)

      assert {:ok, %Bundle{} = bundle} = BundleCache.active(@name, cache)

      assert bundle.name == @name
      assert bundle.version == "1.0.0"
      assert bundle.digest == Bundle.digest_for(@code)
      assert bundle.timeout_ms == 5_000
      assert bundle.code == @code
      assert bundle.params_schema == @params_schema
      assert bundle.output_schema == @output_schema
      assert %ExJsonSchema.Schema.Root{schema: @params_schema} = bundle.resolved_params_schema
      assert %ExJsonSchema.Schema.Root{schema: @output_schema} = bundle.resolved_output_schema
    end

    test "a tampered row is refused by the cache, not served by the loader", context do
      store = start_store(context)
      deploy!(store, %{digest: Bundle.digest_for("tampered")})
      cache = start_cache(store)

      # The loader really does answer: verification is the cache's, so every
      # loader is held to the same check.
      assert {:ok, _envelope, code} = StoreLoader.load(@name, store: store)
      assert code == @code

      assert {:error, :digest_mismatch} = BundleCache.active(@name, cache)
    end
  end
end
