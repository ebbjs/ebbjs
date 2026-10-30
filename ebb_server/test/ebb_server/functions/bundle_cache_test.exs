defmodule EbbServer.Functions.BundleCacheTest do
  use ExUnit.Case, async: true

  alias EbbServer.Functions.Bundle
  alias EbbServer.Functions.Bundle.DirLoader
  alias EbbServer.Functions.BundleCache
  alias EbbServer.TestFunctions.Bundles

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
