defmodule EbbServer.Functions.BundleCacheTest do
  use ExUnit.Case, async: true

  alias EbbServer.Functions.Bundle
  alias EbbServer.Functions.Bundle.DirLoader
  alias EbbServer.Functions.Bundle.StoreLoader
  alias EbbServer.Functions.BundleCache
  alias EbbServer.Functions.Store
  alias EbbServer.TestFunctions.Bundles
  alias EbbServer.TestHelpers

  defmodule CountingLoader do
    @moduledoc false
    @behaviour EbbServer.Functions.Bundle.Loader

    @impl true
    def load(name, opts) do
      send(Keyword.fetch!(opts, :notify), {:loaded, name})
      DirLoader.load(name, Keyword.delete(opts, :notify))
    end
  end

  defmodule RaisingLoader do
    @moduledoc false
    @behaviour EbbServer.Functions.Bundle.Loader

    @impl true
    def load("explode", _opts), do: raise("loader exploded")
    def load(_name, _opts), do: :not_found
  end

  defmodule ConfusedLoader do
    @moduledoc false
    @behaviour EbbServer.Functions.Bundle.Loader

    @impl true
    def load(_name, _opts), do: :ok
  end

  defmodule ExitingLoader do
    @moduledoc false
    @behaviour EbbServer.Functions.Bundle.Loader

    @impl true
    def load("explode", _opts), do: exit(:loader_gone)
    def load(_name, _opts), do: :not_found
  end

  setup do
    %{dir: Bundles.tmp_bundle_dir()}
  end

  defp start_cache(dir, opts \\ []) do
    loader_opts = Keyword.merge([dir: dir], Keyword.get(opts, :loader_opts, []))

    start_supervised!(
      {BundleCache,
       Keyword.merge([name: nil, loader_opts: loader_opts], Keyword.delete(opts, :loader_opts))}
    )
  end

  defp start_store(context) do
    start_supervised!(
      Supervisor.child_spec(
        {Store, name: nil, data_dir: TestHelpers.tmp_dir(context)},
        id: make_ref()
      )
    )
  end

  defp start_store_cache(store) do
    start_supervised!(
      Supervisor.child_spec(
        {BundleCache, name: nil, loader: StoreLoader, loader_opts: [store: store]},
        id: make_ref()
      )
    )
  end

  defp deploy!(store, name, version, code) do
    attrs = %{
      name: name,
      version: version,
      code: code,
      digest: Bundle.digest_for(code),
      runtime: "bun",
      entry: name,
      access: "granted",
      contract: 1,
      timeout_ms: 5_000,
      memory_bytes: 64 * 1024 * 1024
    }

    assert {:ok, _stored} = Store.put_version(attrs, store)
    assert {:ok, _activated} = Store.activate(name, version, store)
  end

  describe "active/1" do
    test "serves the bundle the loader has for the name", %{dir: dir} do
      Bundles.write_bundle!(dir, Bundles.envelope("proofreadDocument"))
      cache = start_cache(dir)

      assert {:ok, %Bundle{} = bundle} = BundleCache.active("proofreadDocument", cache)
      assert bundle.name == "proofreadDocument"
      assert bundle.version == "1.0.0"
      assert bundle.code == Bundles.code()
      assert bundle.digest == Bundle.digest_for(Bundles.code())
    end

    test "defaults to the directory loader", %{dir: dir} do
      Bundles.write_bundle!(dir, Bundles.envelope("proofreadDocument"))
      cache = start_supervised!({BundleCache, name: nil, loader_opts: [dir: dir]})

      assert {:ok, %Bundle{name: "proofreadDocument"}} =
               BundleCache.active("proofreadDocument", cache)
    end
  end

  describe "unknown names" do
    test "are a distinct answer from a failed load", %{dir: dir} do
      cache = start_cache(dir)

      assert {:error, :unknown_function} = BundleCache.active("neverDeployed", cache)
    end

    test "become known once the bundle appears, without a restart", %{dir: dir} do
      cache = start_cache(dir)

      assert {:error, :unknown_function} = BundleCache.active("proofreadDocument", cache)

      Bundles.write_bundle!(dir, Bundles.envelope("proofreadDocument"))

      assert {:ok, %Bundle{name: "proofreadDocument"}} =
               BundleCache.active("proofreadDocument", cache)
    end
  end

  describe "digest verification" do
    test "refuses a bundle whose digest is not its code, and serves nothing", %{dir: dir} do
      cache = start_cache(dir)

      Bundles.write_bundle!(
        dir,
        Bundles.envelope("proofreadDocument", %{"digest" => Bundle.digest_for("tampered")})
      )

      assert {:error, :digest_mismatch} = BundleCache.active("proofreadDocument", cache)

      # The same cache process serves the bundle once the file on disk is
      # corrected: a failure leaves no half-loaded entry behind.
      Bundles.write_bundle!(dir, Bundles.envelope("proofreadDocument"))

      assert {:ok, %Bundle{digest: digest}} = BundleCache.active("proofreadDocument", cache)
      assert digest == Bundle.digest_for(Bundles.code())
    end
  end

  describe "duplicate active versions" do
    test "are refused with the name and version", %{dir: dir} do
      envelope = Bundles.envelope("proofreadDocument")
      Bundles.write_envelope!(dir, envelope, "1.0.0")
      Bundles.write_envelope!(dir, envelope, "1.0.0-copy")
      Bundles.write_code!(dir, "proofreadDocument", "1.0.0")
      cache = start_cache(dir)

      assert {:error, {:duplicate_active_version, {"proofreadDocument", "1.0.0"}}} =
               BundleCache.active("proofreadDocument", cache)
    end
  end

  describe "a bundle replaced on disk" do
    test "is picked up by the same cache process with no restart", %{dir: dir} do
      Bundles.write_bundle!(dir, Bundles.envelope("proofreadDocument"))
      cache = start_cache(dir)

      assert {:ok, %Bundle{code: first}} = BundleCache.active("proofreadDocument", cache)
      assert first == Bundles.code()

      replacement = "export const proofreadDocument = () => ({ ok: false });"

      Bundles.write_bundle!(
        dir,
        Bundles.envelope("proofreadDocument", %{"digest" => Bundle.digest_for(replacement)}),
        replacement
      )

      assert {:ok, %Bundle{code: ^replacement}} = BundleCache.active("proofreadDocument", cache)
      assert Process.alive?(cache)
    end
  end

  describe "loader failures" do
    test "are reported as a failure, not as an unknown function", %{dir: dir} do
      Bundles.write_envelope!(dir, Bundles.envelope("proofreadDocument"))
      cache = start_cache(dir)

      assert {:error, {:loader_failed, {:missing_code, "proofreadDocument", "1.0.0"}}} =
               BundleCache.active("proofreadDocument", cache)

      Bundles.write_code!(dir, "proofreadDocument", "1.0.0")

      assert {:ok, %Bundle{}} = BundleCache.active("proofreadDocument", cache)
    end

    test "a loader that raises does not take the cache down" do
      cache = start_supervised!({BundleCache, name: nil, loader: RaisingLoader})

      assert {:error, {:loader_failed, {:loader_crashed, "loader exploded"}}} =
               BundleCache.active("explode", cache)

      assert {:error, :unknown_function} = BundleCache.active("quiet", cache)
      assert Process.alive?(cache)
    end

    test "a loader that answers a shape the cache does not know is a failure" do
      cache = start_supervised!({BundleCache, name: nil, loader: ConfusedLoader})

      assert {:error, {:loader_failed, {:unexpected_result, :ok}}} =
               BundleCache.active("anything", cache)

      assert Process.alive?(cache)
    end

    test "a loader that exits does not take the cache down" do
      cache = start_supervised!({BundleCache, name: nil, loader: ExitingLoader})

      assert {:error, {:loader_failed, {:loader_crashed, :loader_gone}}} =
               BundleCache.active("explode", cache)

      assert Process.alive?(cache)
    end
  end

  describe "envelope validation" do
    test "refuses a bundle that is loaded but not valid", %{dir: dir} do
      cache = start_cache(dir)

      Bundles.write_bundle!(
        dir,
        Bundles.envelope("proofreadDocument", %{"access" => "public"})
      )

      assert {:error, {:invalid_bundle, {:invalid_field, "access"}}} =
               BundleCache.active("proofreadDocument", cache)
    end

    test "refuses a bundle built against a newer contract", %{dir: dir} do
      cache = start_cache(dir)

      Bundles.write_bundle!(
        dir,
        Bundles.envelope("proofreadDocument", %{"contract" => 2})
      )

      assert {:error, {:invalid_bundle, {:unsupported_contract, 2}}} =
               BundleCache.active("proofreadDocument", cache)
    end

    test "refuses a bundle whose name breaks the grammar", %{dir: dir} do
      cache = start_cache(dir)

      Bundles.write_bundle!(dir, Bundles.envelope("1function"))
      Bundles.write_bundle!(dir, Bundles.envelope("default"))

      assert {:error, {:invalid_bundle, {:invalid_name, "1function"}}} =
               BundleCache.active("1function", cache)

      assert {:error, {:invalid_bundle, {:invalid_name, "default"}}} =
               BundleCache.active("default", cache)
    end
  end

  describe "the index" do
    test "is refreshed through the loader on every call", %{dir: dir} do
      Bundles.write_bundle!(dir, Bundles.envelope("proofreadDocument"))
      cache = start_cache(dir, loader: CountingLoader, loader_opts: [notify: self()])

      assert {:ok, %Bundle{}} = BundleCache.active("proofreadDocument", cache)
      assert_received {:loaded, "proofreadDocument"}

      assert {:ok, %Bundle{}} = BundleCache.active("proofreadDocument", cache)
      assert_received {:loaded, "proofreadDocument"}
    end

    test "picks up an envelope change that keeps the code and digest", %{dir: dir} do
      envelope = Bundles.envelope("proofreadDocument")
      Bundles.write_bundle!(dir, envelope)
      cache = start_cache(dir)

      assert {:ok, %Bundle{timeout_ms: 30_000}} =
               BundleCache.active("proofreadDocument", cache)

      # Same code and digest, new access and timeout: the fingerprint covers
      # every field that reaches the struct, so the cache cannot keep serving
      # the old policy for unchanged bytes.
      Bundles.write_bundle!(dir, %{envelope | "timeoutMs" => 1_000, "access" => "authenticated"})

      assert {:ok, %Bundle{timeout_ms: 1_000, access: "authenticated"}} =
               BundleCache.active("proofreadDocument", cache)
    end

    test "picks up a schema change that keeps the code and digest", %{dir: dir} do
      envelope = Bundles.envelope("proofreadDocument")
      Bundles.write_bundle!(dir, envelope)
      cache = start_cache(dir)

      assert {:ok, %Bundle{params_schema: nil, resolved_params_schema: nil, code: code}} =
               BundleCache.active("proofreadDocument", cache)

      params_schema = %{"type" => "object", "required" => ["documentId"]}
      Bundles.write_bundle!(dir, Map.put(envelope, "paramsSchema", params_schema))

      assert {:ok,
              %Bundle{
                params_schema: ^params_schema,
                resolved_params_schema: %ExJsonSchema.Schema.Root{schema: ^params_schema},
                code: ^code
              }} = BundleCache.active("proofreadDocument", cache)
    end

    test "keeps serving a good name after another name fails", %{dir: dir} do
      Bundles.write_bundle!(dir, Bundles.envelope("goodFunction"))
      Bundles.write_envelope!(dir, Bundles.envelope("badFunction"))
      cache = start_cache(dir)

      assert {:ok, %Bundle{name: "goodFunction"}} = BundleCache.active("goodFunction", cache)

      assert {:error, {:loader_failed, {:missing_code, "badFunction", "1.0.0"}}} =
               BundleCache.active("badFunction", cache)

      assert {:ok, %Bundle{name: "goodFunction"}} = BundleCache.active("goodFunction", cache)
    end
  end

  describe "an activation during an invocation" do
    test "does not affect that invocation", context do
      store = start_store(context)
      v1_code = "export const pinned = () => ({ version: 1 });"
      v2_code = "export const pinned = () => ({ version: 2 });"

      deploy!(store, "pinnedFunction", "1.0.0", v1_code)
      cache = start_store_cache(store)

      # An invocation resolves its bundle once and holds the struct for the
      # rest of the run; what the store serves afterwards is not its concern.
      assert {:ok, %Bundle{version: "1.0.0"} = held} = BundleCache.active("pinnedFunction", cache)
      assert held.code == v1_code

      deploy!(store, "pinnedFunction", "2.0.0", v2_code)

      assert held.version == "1.0.0"
      assert held.code == v1_code

      assert {:ok, %Bundle{version: "2.0.0"} = fresh} =
               BundleCache.active("pinnedFunction", cache)

      assert fresh.code == v2_code
    end
  end

  describe "start_link/1" do
    test "registers under an explicit name" do
      name = :"bundle_cache_#{System.unique_integer([:positive])}"

      pid = start_supervised!({BundleCache, name: name, loader: RaisingLoader})
      assert Process.whereis(name) == pid
    end

    test "exposes a plain child spec a supervisor can hold" do
      assert %{id: BundleCache, start: {BundleCache, :start_link, [_opts]}} =
               BundleCache.child_spec(loader: DirLoader, loader_opts: [])
    end
  end
end
