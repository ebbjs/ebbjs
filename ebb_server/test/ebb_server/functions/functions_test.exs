defmodule EbbServer.FunctionsTest do
  use ExUnit.Case, async: false

  alias EbbServer.Functions
  alias EbbServer.Functions.Bundle.{DirLoader, StoreLoader}
  alias EbbServer.Functions.{BundleCache, Store}
  alias EbbServer.Functions.Worker.Fake

  @env_key "EBB_FUNCTIONS_ENABLED"

  setup do
    previous = Application.get_env(:ebb_server, :functions)
    previous_env = System.get_env(@env_key)

    on_exit(fn ->
      case previous do
        nil -> Application.delete_env(:ebb_server, :functions)
        value -> Application.put_env(:ebb_server, :functions, value)
      end

      case previous_env do
        nil -> System.delete_env(@env_key)
        value -> System.put_env(@env_key, value)
      end
    end)

    :ok
  end

  # Merge over the environment's base so a test that only changes `enabled`
  # still gets the suite's fake transport and never trips the Bun boot check.
  defp configure(config) do
    base = Application.get_env(:ebb_server, :functions, [])
    Application.put_env(:ebb_server, :functions, Keyword.merge(base, config))
  end

  describe "enabled?/0" do
    test "is false when nothing is configured" do
      Application.delete_env(:ebb_server, :functions)

      refute Functions.enabled?()
    end

    test "reads the value resolved at boot" do
      configure(enabled: true)

      assert Functions.enabled?()
    end

    test "a nil value is unset, not a value to parse" do
      configure(enabled: nil)

      refute Functions.enabled?()
    end

    test "an unrecognized compiled value raises and names the key" do
      configure(enabled: "maybe")

      error = assert_raise(RuntimeError, fn -> Functions.enabled?() end)
      assert error.message =~ ":ebb_server, :functions, enabled"
      assert error.message =~ ~s("maybe")
    end

    test "ignores the environment after boot" do
      configure(enabled: false)
      System.put_env(@env_key, "true")

      refute Functions.enabled?()
    end
  end

  describe "resolve/0" do
    test "reads the compiled value when the environment is silent" do
      configure(enabled: true)
      System.delete_env(@env_key)

      assert Functions.resolve()
    end

    test "accepts the string forms the environment can carry" do
      configure(enabled: false)

      for {raw, expected} <- [{"true", true}, {"false", false}, {"1", true}, {"0", false}] do
        System.put_env(@env_key, raw)
        assert Functions.resolve() == expected
      end
    end

    test "the environment wins over the compiled value both ways" do
      configure(enabled: false)
      System.put_env(@env_key, "true")
      assert Functions.resolve()

      configure(enabled: true)
      System.put_env(@env_key, "false")
      refute Functions.resolve()
    end

    test "a blank environment value is unset, not false" do
      configure(enabled: true)
      System.put_env(@env_key, "  ")

      assert Functions.resolve()
    end

    test "an unrecognized environment value raises instead of disabling" do
      configure(enabled: false)
      System.put_env(@env_key, "yes")

      error = assert_raise(RuntimeError, fn -> Functions.resolve() end)
      assert error.message =~ "EBB_FUNCTIONS_ENABLED must be true or false"
      assert error.message =~ ~s("yes")
    end
  end

  describe "resolve!/0" do
    test "writes the resolved environment value back into the nested key" do
      configure(enabled: false, bundle_dir: "/srv/functions/bundles")
      System.put_env(@env_key, "true")

      assert :ok = Functions.resolve!()
      assert Application.get_env(:ebb_server, :functions)[:enabled] == true
      assert Functions.enabled?()

      # The environment is read once: flipping it later cannot change a booted
      # node's answer, so the route and the cache cannot disagree.
      System.put_env(@env_key, "false")
      assert Functions.enabled?()
    end
  end

  describe "children/1" do
    test "is empty while functions are disabled" do
      configure(enabled: false, bundle_dir: "/srv/functions/bundles")

      assert Functions.children(data_dir: "/tmp/functions") == []
    end

    test "is a bundle cache over the directory loader when a bundle_dir is configured" do
      configure(enabled: true, bundle_dir: "/srv/functions/bundles")

      assert [stats_spec, spec] = Functions.children(data_dir: "/tmp/functions")
      assert Supervisor.child_spec(stats_spec, []).id == EbbServer.Functions.Stats

      assert %{
               id: BundleCache,
               start: {BundleCache, :start_link, [opts]}
             } = Supervisor.child_spec(spec, [])

      assert opts[:loader] == DirLoader
      assert opts[:loader_opts] == [dir: "/srv/functions/bundles"]
    end

    test "is the store then the cache over the store loader without a bundle_dir" do
      configure(enabled: true, retention: 5, admin_token: "deploy-secret")

      assert [_stats_spec, store_spec, cache_spec] =
               Functions.children(data_dir: "/srv/ebb/data")

      assert %{
               id: Store,
               start: {Store, :start_link, [store_opts]}
             } = Supervisor.child_spec(store_spec, [])

      assert store_opts[:data_dir] == "/srv/ebb/data"
      assert store_opts[:retention] == 5

      assert %{
               id: BundleCache,
               start: {BundleCache, :start_link, [cache_opts]}
             } = Supervisor.child_spec(cache_spec, [])

      assert cache_opts[:loader] == StoreLoader
      assert cache_opts[:loader_opts] == [store: Store]
    end

    test "falls back to the application data dir when no data_dir is passed" do
      configure(enabled: true)
      previous = Application.get_env(:ebb_server, :data_dir)
      Application.put_env(:ebb_server, :data_dir, "/srv/ebb/configured")

      on_exit(fn ->
        case previous do
          nil -> Application.delete_env(:ebb_server, :data_dir)
          value -> Application.put_env(:ebb_server, :data_dir, value)
        end
      end)

      assert [_stats, {Store, opts}, {BundleCache, _cache_opts}] = Functions.children()

      assert opts[:data_dir] == "/srv/ebb/configured"
    end

    test "a blank bundle_dir is not configured" do
      configure(enabled: true, bundle_dir: "")

      assert [_stats, {Store, _store_opts}, {BundleCache, _cache_opts}] =
               Functions.children(data_dir: "/srv/ebb/data")
    end

    test "bundle_dir!/0 still refuses when asked directly" do
      configure(enabled: true)

      error = assert_raise(RuntimeError, fn -> Functions.bundle_dir!() end)
      assert error.message =~ ":bundle_dir is not set"
    end
  end

  describe "retention/0 and admin_token/0" do
    test "retention defaults to 20 and reads the configured value" do
      configure(enabled: true)
      assert Functions.retention() == 20

      configure(enabled: true, retention: 3)
      assert Functions.retention() == 3
    end

    test "admin_token is nil when unset or blank" do
      configure(enabled: true)
      assert Functions.admin_token() == nil

      configure(enabled: true, admin_token: "")
      assert Functions.admin_token() == nil

      configure(enabled: true, admin_token: "   ")
      assert Functions.admin_token() == nil
    end

    test "admin_token reads the configured deploy credential" do
      configure(enabled: true, admin_token: "deploy-secret")

      assert Functions.admin_token() == "deploy-secret"
    end
  end

  describe "the worker seam" do
    test "reads the suite's fake transport from the environment" do
      configure(enabled: true, bundle_dir: "/srv/functions/bundles")

      assert Functions.transport() == Fake
      assert Functions.worker_opts() == []
    end

    test "reads the configured transport and options" do
      configure(
        enabled: true,
        bundle_dir: "/srv/functions/bundles",
        transport: __MODULE__,
        worker_opts: [script: []]
      )

      assert Functions.transport() == __MODULE__
      assert Functions.worker_opts() == [script: []]
    end
  end
end
