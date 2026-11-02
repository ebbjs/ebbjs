defmodule EbbServer.FunctionsTest do
  use ExUnit.Case, async: false

  alias EbbServer.Functions
  alias EbbServer.Functions.Bundle.DirLoader
  alias EbbServer.Functions.BundleCache
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

  defp configure(config), do: Application.put_env(:ebb_server, :functions, config)

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

  describe "children/0" do
    test "is empty while functions are disabled" do
      configure(enabled: false)

      assert Functions.children() == []
    end

    test "is a bundle cache over the directory loader when enabled" do
      configure(enabled: true, bundle_dir: "/srv/functions/bundles")

      assert [spec] = Functions.children()

      assert %{
               id: BundleCache,
               start: {BundleCache, :start_link, [opts]}
             } = Supervisor.child_spec(spec, [])

      assert opts[:loader] == DirLoader
      assert opts[:loader_opts] == [dir: "/srv/functions/bundles"]
    end

    test "refuses to enable functions without a bundle directory" do
      configure(enabled: true)

      error = assert_raise(RuntimeError, fn -> Functions.children() end)
      assert error.message =~ ":bundle_dir is not set"
    end
  end

  describe "the worker seam" do
    test "defaults to the in-process fake with no options" do
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
