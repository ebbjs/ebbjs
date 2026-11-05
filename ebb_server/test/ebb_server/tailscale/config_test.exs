defmodule EbbServer.Tailscale.ConfigTest do
  @moduledoc """
  Proves the tailscale settings resolve the way an operator would expect from
  the environment: one variable per setting, the environment over the compiled
  application env, and a boot failure on anything the gateway cannot use.

  `async: false` because the resolver reads and writes process-global state.
  """

  use ExUnit.Case, async: false

  alias EbbServer.Tailscale.Config

  @env_keys ~w(
    EBB_TAILSCALE_NODE EBB_TAILSCALE_STATE_DIR EBB_TAILSCALE_HOSTNAME EBB_TAILSCALE_AUTHKEY
    EBB_TAILSCALE_CONTROL_URL EBB_TAILSCALE_TAGS EBB_TAILSCALE_REQUIRE_TAGS
    EBB_TAILSCALE_HTTPS EBB_TAILSCALE_QR EBB_TAILSCALE_PROXY_BIN
  )

  @app_keys ~w(
    tailscale_node tailscale_state_dir tailscale_hostname tailscale_authkey
    tailscale_control_url tailscale_tags tailscale_require_tags tailscale_https
    tailscale_qr tailscale_proxy_bin
  )a

  @data_dir "/var/lib/ebb"

  setup do
    env_snapshot = Map.new(@env_keys, &{&1, System.get_env(&1)})
    app_snapshot = Map.new(@app_keys, &{&1, Application.get_env(:ebb_server, &1)})

    Enum.each(@env_keys, &System.delete_env/1)
    Enum.each(@app_keys, &Application.delete_env(:ebb_server, &1))

    dir = Path.join(System.tmp_dir!(), "ebb_ts_config_#{System.unique_integer([:positive])}")
    File.mkdir_p!(dir)

    on_exit(fn ->
      restore_env(env_snapshot)
      restore_app(app_snapshot)
      File.rm_rf(dir)
    end)

    %{bin: write_bin!(dir, "gateway"), dir: dir}
  end

  describe "resolve/2 defaults" do
    test "resolves the documented default for every setting", %{bin: bin} do
      System.put_env("EBB_TAILSCALE_PROXY_BIN", bin)

      assert %{
               node: :embedded,
               state_dir: "/var/lib/ebb/tailscale",
               hostname: "ebb",
               auth_key: nil,
               control_url: nil,
               tags: [],
               require_tags: false,
               https: "auto",
               qr: true,
               proxy_bin: ^bin,
               backend_addr: "127.0.0.1:4000"
             } = Config.resolve(@data_dir, 4000)
    end

    test "defaults the proxy binary to the bundled gateway" do
      System.put_env("EBB_TAILSCALE_NODE", "external")
      expected = Application.app_dir(:ebb_server, "priv/tsnode/ebb_tsnode")

      assert %{proxy_bin: ^expected} = Config.resolve(@data_dir, 4000)
    end

    test "names the variable and the override when the binary is missing" do
      missing = "/nonexistent/ebb_tsnode"
      System.put_env("EBB_TAILSCALE_PROXY_BIN", missing)

      error = assert_raise RuntimeError, fn -> Config.resolve(@data_dir, 4000) end

      assert error.message =~ "EBB_TAILSCALE_PROXY_BIN"
      assert error.message =~ missing
    end

    test "builds the backend address from the resolved port", %{bin: bin} do
      System.put_env("EBB_TAILSCALE_PROXY_BIN", bin)

      assert %{backend_addr: "127.0.0.1:4321"} = Config.resolve(@data_dir, 4321)
    end
  end

  describe "environment over application env" do
    test "the environment wins for every setting", %{dir: dir} do
      env_bin = write_bin!(dir, "env_gateway")
      app_bin = write_bin!(dir, "app_gateway")

      cases = [
        {"EBB_TAILSCALE_NODE", "external", :tailscale_node, :embedded, :node, :external},
        {"EBB_TAILSCALE_STATE_DIR", "/env/state", :tailscale_state_dir, "/app/state", :state_dir,
         "/env/state"},
        {"EBB_TAILSCALE_HOSTNAME", "env-host", :tailscale_hostname, "app-host", :hostname,
         "env-host"},
        {"EBB_TAILSCALE_AUTHKEY", "tskey-env", :tailscale_authkey, "tskey-app", :auth_key,
         "tskey-env"},
        {"EBB_TAILSCALE_CONTROL_URL", "https://env.control", :tailscale_control_url,
         "https://app.control", :control_url, "https://env.control"},
        {"EBB_TAILSCALE_TAGS", "tag:env, tag:extra", :tailscale_tags, ["tag:app"], :tags,
         ["tag:env", "tag:extra"]},
        {"EBB_TAILSCALE_REQUIRE_TAGS", "true", :tailscale_require_tags, false, :require_tags,
         true},
        {"EBB_TAILSCALE_HTTPS", "off", :tailscale_https, "on", :https, "off"},
        {"EBB_TAILSCALE_QR", "false", :tailscale_qr, true, :qr, false},
        {"EBB_TAILSCALE_PROXY_BIN", env_bin, :tailscale_proxy_bin, app_bin, :proxy_bin, env_bin}
      ]

      Enum.each(cases, fn {env_key, env_value, app_key, app_value, field, expected} ->
        System.put_env(env_key, env_value)
        Application.put_env(:ebb_server, app_key, app_value)

        assert Map.fetch!(Config.resolve(@data_dir, 4000), field) == expected,
               "#{env_key} did not win over :#{app_key}"
      end)
    end

    test "a blank environment value counts as unset and falls back", %{bin: bin} do
      Application.put_env(:ebb_server, :tailscale_hostname, "app-host")
      Application.put_env(:ebb_server, :tailscale_tags, ["tag:app"])
      Application.put_env(:ebb_server, :tailscale_qr, false)

      System.put_env("EBB_TAILSCALE_HOSTNAME", "   ")
      System.put_env("EBB_TAILSCALE_TAGS", " ")
      System.put_env("EBB_TAILSCALE_QR", "")
      System.put_env("EBB_TAILSCALE_PROXY_BIN", bin)

      assert %{hostname: "app-host", tags: ["tag:app"], qr: false} =
               Config.resolve(@data_dir, 4000)
    end
  end

  describe "tags" do
    test "splits a comma or whitespace separated environment value", %{bin: bin} do
      System.put_env("EBB_TAILSCALE_PROXY_BIN", bin)
      System.put_env("EBB_TAILSCALE_TAGS", "tag:ebb, tag:other\ttag:third  tag:fourth")

      assert %{tags: ["tag:ebb", "tag:other", "tag:third", "tag:fourth"]} =
               Config.resolve(@data_dir, 4000)
    end

    test "accepts a list in the application env", %{bin: bin} do
      System.put_env("EBB_TAILSCALE_PROXY_BIN", bin)
      Application.put_env(:ebb_server, :tailscale_tags, ["tag:ebb"])

      assert %{tags: ["tag:ebb"]} = Config.resolve(@data_dir, 4000)
    end

    test "rejects a name that is not a tag", %{bin: bin} do
      System.put_env("EBB_TAILSCALE_PROXY_BIN", bin)
      System.put_env("EBB_TAILSCALE_TAGS", "tag:ebb, ebb")

      error = assert_raise RuntimeError, fn -> Config.resolve(@data_dir, 4000) end
      assert error.message =~ "EBB_TAILSCALE_TAGS"
    end

    test "rejects an empty tag name", %{bin: bin} do
      System.put_env("EBB_TAILSCALE_PROXY_BIN", bin)
      System.put_env("EBB_TAILSCALE_TAGS", "tag:")

      error = assert_raise RuntimeError, fn -> Config.resolve(@data_dir, 4000) end
      assert error.message =~ "tag:ebb"
    end

    test "rejects a value that is neither a string nor a list", %{bin: bin} do
      System.put_env("EBB_TAILSCALE_PROXY_BIN", bin)
      Application.put_env(:ebb_server, :tailscale_tags, 42)

      assert_raise RuntimeError, ~r/EBB_TAILSCALE_TAGS/, fn ->
        Config.resolve(@data_dir, 4000)
      end
    end
  end

  describe "booleans" do
    test "accepts the documented spellings", %{bin: bin} do
      System.put_env("EBB_TAILSCALE_PROXY_BIN", bin)

      for value <- ~w(true 1 yes on) do
        System.put_env("EBB_TAILSCALE_REQUIRE_TAGS", value)
        assert %{require_tags: true} = Config.resolve(@data_dir, 4000)
      end

      for value <- ~w(false 0 no off) do
        System.put_env("EBB_TAILSCALE_QR", value)
        assert %{qr: false} = Config.resolve(@data_dir, 4000)
      end
    end

    test "raises on a value that is not a boolean", %{bin: bin} do
      System.put_env("EBB_TAILSCALE_PROXY_BIN", bin)
      System.put_env("EBB_TAILSCALE_QR", "maybe")

      error = assert_raise RuntimeError, fn -> Config.resolve(@data_dir, 4000) end
      assert error.message =~ "EBB_TAILSCALE_QR must be"
    end
  end

  describe "mode validation" do
    test "rejects an unknown node mode" do
      System.put_env("EBB_TAILSCALE_NODE", "tails")

      error = assert_raise RuntimeError, fn -> Config.resolve(@data_dir, 4000) end
      assert error.message =~ "EBB_TAILSCALE_NODE must be one of: embedded, external"
    end

    test "accepts atoms and booleans from the application env" do
      Application.put_env(:ebb_server, :tailscale_node, :external)
      Application.put_env(:ebb_server, :tailscale_https, :off)
      Application.put_env(:ebb_server, :tailscale_qr, true)

      assert %{node: :external, https: "off", qr: true} = Config.resolve(@data_dir, 4000)
    end

    test "rejects a non-string node mode in the application env" do
      Application.put_env(:ebb_server, :tailscale_node, 42)

      assert_raise RuntimeError, ~r/EBB_TAILSCALE_NODE must be one of/, fn ->
        Config.resolve(@data_dir, 4000)
      end
    end

    test "rejects an unknown https mode" do
      System.put_env("EBB_TAILSCALE_NODE", "external")
      System.put_env("EBB_TAILSCALE_HTTPS", "tls")

      error = assert_raise RuntimeError, fn -> Config.resolve(@data_dir, 4000) end
      assert error.message =~ "EBB_TAILSCALE_HTTPS must be one of: auto, on, off"
    end

    test "rejects a non-string string setting" do
      System.put_env("EBB_TAILSCALE_NODE", "external")
      Application.put_env(:ebb_server, :tailscale_hostname, :ebb)

      assert_raise RuntimeError, ~r/EBB_TAILSCALE_HOSTNAME must be a string/, fn ->
        Config.resolve(@data_dir, 4000)
      end
    end
  end

  describe "the embedded proxy binary" do
    test "rejects a file that is not executable", %{dir: dir} do
      path = Path.join(dir, "not_executable")
      File.write!(path, "#!/bin/sh\nexit 0\n")
      File.chmod!(path, 0o644)

      System.put_env("EBB_TAILSCALE_PROXY_BIN", path)

      error = assert_raise RuntimeError, fn -> Config.resolve(@data_dir, 4000) end
      assert error.message =~ "missing or not executable"
      assert error.message =~ path
    end

    test "rejects a directory that happens to be executable", %{dir: dir} do
      path = Path.join(dir, "gateway_dir")
      File.mkdir_p!(path)
      File.chmod!(path, 0o755)

      System.put_env("EBB_TAILSCALE_PROXY_BIN", path)

      error = assert_raise RuntimeError, fn -> Config.resolve(@data_dir, 4000) end
      assert error.message =~ "missing or not executable"
    end

    test "is not required for an external node" do
      System.put_env("EBB_TAILSCALE_NODE", "external")
      System.put_env("EBB_TAILSCALE_PROXY_BIN", "/nonexistent/ebb_tsnode")

      assert %{node: :external, proxy_bin: "/nonexistent/ebb_tsnode"} =
               Config.resolve(@data_dir, 4000)
    end
  end

  describe "the hostname" do
    test "accepts a DNS label", %{bin: bin} do
      System.put_env("EBB_TAILSCALE_PROXY_BIN", bin)

      for hostname <- ["ebb", "ebb-2", "E", String.duplicate("a", 63)] do
        System.put_env("EBB_TAILSCALE_HOSTNAME", hostname)

        assert %{hostname: hostname} = Config.resolve(@data_dir, 4000)
      end
    end

    test "rejects a value tsnet cannot register", %{bin: bin} do
      System.put_env("EBB_TAILSCALE_PROXY_BIN", bin)

      for hostname <- ["ebb.example.com", "ebb_1", "-ebb", "ebb-", String.duplicate("a", 64)] do
        System.put_env("EBB_TAILSCALE_HOSTNAME", hostname)

        error = assert_raise RuntimeError, fn -> Config.resolve(@data_dir, 4000) end
        assert error.message =~ "EBB_TAILSCALE_HOSTNAME"
        assert error.message =~ inspect(hostname)
      end
    end
  end

  defp write_bin!(dir, name) do
    path = Path.join(dir, name)
    File.write!(path, "#!/bin/sh\nexit 0\n")
    File.chmod!(path, 0o755)
    path
  end

  defp restore_env(snapshot) do
    Enum.each(snapshot, fn
      {key, nil} -> System.delete_env(key)
      {key, value} -> System.put_env(key, value)
    end)
  end

  defp restore_app(snapshot) do
    Enum.each(snapshot, fn
      {key, nil} -> Application.delete_env(:ebb_server, key)
      {key, value} -> Application.put_env(:ebb_server, key, value)
    end)
  end
end
