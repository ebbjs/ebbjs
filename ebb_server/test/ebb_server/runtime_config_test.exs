defmodule EbbServer.RuntimeConfigTest do
  use ExUnit.Case, async: false

  import ExUnit.CaptureIO

  setup do
    original_app_port = Application.get_env(:ebb_server, :port)
    original_env = System.get_env("EBB_PORT")
    original_auth_mode = Application.get_env(:ebb_server, :auth_mode)
    original_auth_url = Application.get_env(:ebb_server, :auth_url)
    original_env_auth_mode = System.get_env("EBB_AUTH_MODE")
    original_env_auth_url = System.get_env("EBB_AUTH_URL")

    on_exit(fn ->
      restore_env(:ebb_server, :port, original_app_port)
      restore_env_var("EBB_PORT", original_env)
      restore_env(:ebb_server, :auth_mode, original_auth_mode)
      restore_env(:ebb_server, :auth_url, original_auth_url)
      restore_env_var("EBB_AUTH_MODE", original_env_auth_mode)
      restore_env_var("EBB_AUTH_URL", original_env_auth_url)
    end)

    :ok
  end

  describe "runtime_port/0 precedence" do
    test "returns the application env when set, ignoring EBB_PORT" do
      Application.put_env(:ebb_server, :port, 4001)
      System.put_env("EBB_PORT", "9999")

      assert EbbServer.Application.runtime_port() == 4001
    end

    test "returns EBB_PORT when application env is unset" do
      Application.delete_env(:ebb_server, :port)
      System.put_env("EBB_PORT", "5555")

      assert EbbServer.Application.runtime_port() == 5555
    end

    test "falls back to 4000 when neither is set" do
      Application.delete_env(:ebb_server, :port)
      System.delete_env("EBB_PORT")

      assert EbbServer.Application.runtime_port() == 4000
    end

    test "treats empty EBB_PORT as malformed and raises" do
      Application.delete_env(:ebb_server, :port)
      System.put_env("EBB_PORT", "")

      assert_raise RuntimeError, ~r/EBB_PORT must be an integer/, fn ->
        EbbServer.Application.runtime_port()
      end
    end

    test "raises on a non-integer EBB_PORT so typos surface at boot" do
      Application.delete_env(:ebb_server, :port)
      System.put_env("EBB_PORT", "4000x")

      assert_raise RuntimeError, ~r/EBB_PORT must be an integer/, fn ->
        EbbServer.Application.runtime_port()
      end
    end

    test "treats a trailing-whitespace EBB_PORT as malformed" do
      Application.delete_env(:ebb_server, :port)
      System.put_env("EBB_PORT", "5000 ")

      assert_raise RuntimeError, ~r/EBB_PORT must be an integer/, fn ->
        EbbServer.Application.runtime_port()
      end
    end

    test "accepts a negative port (operator may bind to a non-privileged port via reverse proxy)" do
      Application.delete_env(:ebb_server, :port)
      System.put_env("EBB_PORT", "-1")

      assert EbbServer.Application.runtime_port() == -1
    end
  end

  describe "runtime_auth/0 resolution" do
    test "EBB_AUTH_MODE wins over a compiled :external application env" do
      Application.put_env(:ebb_server, :auth_mode, :external)
      Application.put_env(:ebb_server, :auth_url, "https://app-config.example/auth")
      System.put_env("EBB_AUTH_MODE", "bypass")

      assert EbbServer.Application.runtime_auth() == {:bypass, nil}
    end

    test "EBB_AUTH_MODE and EBB_AUTH_URL win over the application env together" do
      Application.put_env(:ebb_server, :auth_mode, :bypass)
      Application.put_env(:ebb_server, :auth_url, "https://app-config.example/auth")
      System.put_env("EBB_AUTH_MODE", "external")
      System.put_env("EBB_AUTH_URL", "https://env.example/auth")

      assert EbbServer.Application.runtime_auth() == {:external, "https://env.example/auth"}
    end

    test "falls back to the application env when EBB_AUTH_MODE is unset" do
      System.delete_env("EBB_AUTH_MODE")
      System.delete_env("EBB_AUTH_URL")
      Application.put_env(:ebb_server, :auth_mode, :external)
      Application.put_env(:ebb_server, :auth_url, "https://app-config.example/auth")

      assert EbbServer.Application.runtime_auth() ==
               {:external, "https://app-config.example/auth"}
    end

    test "treats a blank EBB_AUTH_MODE as unset and falls back" do
      System.put_env("EBB_AUTH_MODE", "   ")
      Application.put_env(:ebb_server, :auth_mode, :bypass)

      assert EbbServer.Application.runtime_auth() == {:bypass, nil}
    end

    test "raises before boot when neither EBB_AUTH_MODE nor the application env is set" do
      System.delete_env("EBB_AUTH_MODE")
      Application.delete_env(:ebb_server, :auth_mode)

      assert_raise RuntimeError, ~r/EBB_AUTH_MODE.*bypass.*external/s, fn ->
        EbbServer.Application.runtime_auth()
      end
    end

    test "raises on an invalid EBB_AUTH_MODE even when the application env is valid" do
      System.put_env("EBB_AUTH_MODE", "bypas")
      Application.put_env(:ebb_server, :auth_mode, :bypass)

      assert_raise RuntimeError, ~r/EBB_AUTH_MODE must be one of.*bypass.*external/s, fn ->
        EbbServer.Application.runtime_auth()
      end
    end

    test "raises when :external has no EBB_AUTH_URL or application env url" do
      System.put_env("EBB_AUTH_MODE", "external")
      System.delete_env("EBB_AUTH_URL")
      Application.delete_env(:ebb_server, :auth_url)

      assert_raise RuntimeError, ~r/EBB_AUTH_URL/, fn ->
        EbbServer.Application.runtime_auth()
      end
    end

    test "raises when :external has a blank EBB_AUTH_URL and no application env url" do
      System.put_env("EBB_AUTH_MODE", "external")
      System.put_env("EBB_AUTH_URL", "  ")
      Application.delete_env(:ebb_server, :auth_url)

      assert_raise RuntimeError, ~r/EBB_AUTH_URL/, fn ->
        EbbServer.Application.runtime_auth()
      end
    end

    test "resolves :bypass without requiring an auth URL" do
      System.put_env("EBB_AUTH_MODE", "bypass")
      System.put_env("EBB_AUTH_URL", "https://ignored.example/auth")

      assert EbbServer.Application.runtime_auth() == {:bypass, nil}
    end

    test "resolves :tailscale without requiring an auth URL" do
      System.put_env("EBB_AUTH_MODE", "tailscale")
      System.put_env("EBB_AUTH_URL", "https://ignored.example/auth")
      Application.put_env(:ebb_server, :auth_url, "https://ignored.example/auth")

      assert EbbServer.Application.runtime_auth() == {:tailscale, nil}
    end

    test "the unset-mode message names every accepted mode" do
      System.delete_env("EBB_AUTH_MODE")
      Application.delete_env(:ebb_server, :auth_mode)

      assert_raise RuntimeError, ~r/bypass, external, tailscale/, fn ->
        EbbServer.Application.runtime_auth()
      end
    end

    test "the invalid-mode message names every accepted mode" do
      System.put_env("EBB_AUTH_MODE", "tailscalee")

      assert_raise RuntimeError, ~r/bypass, external, tailscale/, fn ->
        EbbServer.Application.runtime_auth()
      end
    end

    test "the test suite boots on the explicit :bypass config from config/test.exs" do
      assert Application.get_env(:ebb_server, :auth_mode) == :bypass
    end
  end

  describe "bind_ip/1" do
    test "tailscale mode binds IPv4 loopback" do
      assert EbbServer.Application.bind_ip(:tailscale) == {127, 0, 0, 1}
    end

    test "every other mode keeps Bandit's default interface" do
      assert EbbServer.Application.bind_ip(:bypass) == :any
      assert EbbServer.Application.bind_ip(:external) == :any
    end
  end

  describe "bandit_options/2" do
    test "tailscale mode hands Bandit the loopback address" do
      options = EbbServer.Application.bandit_options(4000, :tailscale)

      assert options[:ip] == {127, 0, 0, 1}
      assert options[:port] == 4000
      assert options[:plug] == EbbServer.Sync.Router
    end

    test "other modes leave the interface to Bandit" do
      refute Keyword.has_key?(EbbServer.Application.bandit_options(4000, :bypass), :ip)
      refute Keyword.has_key?(EbbServer.Application.bandit_options(4000, :external), :ip)
    end
  end

  describe "validate_tailscale_secret!/2" do
    test "accepts an unset secret or a non-empty string" do
      assert EbbServer.Application.validate_tailscale_secret!(:tailscale, nil) == :ok
      assert EbbServer.Application.validate_tailscale_secret!(:tailscale, "abc") == :ok
    end

    test "rejects an empty or non-string secret at boot" do
      assert_raise RuntimeError, ~r/tailscale_proxy_secret/, fn ->
        EbbServer.Application.validate_tailscale_secret!(:tailscale, "")
      end

      assert_raise RuntimeError, ~r/tailscale_proxy_secret/, fn ->
        EbbServer.Application.validate_tailscale_secret!(:tailscale, :nope)
      end
    end

    test "ignores the secret outside tailscale mode" do
      assert EbbServer.Application.validate_tailscale_secret!(:bypass, :nope) == :ok
    end
  end

  describe "resolve_tailscale!/2" do
    setup do
      original_node = Application.get_env(:ebb_server, :tailscale_node)
      original_bin = Application.get_env(:ebb_server, :tailscale_proxy_bin)
      original_secret = Application.get_env(:ebb_server, :tailscale_proxy_secret)
      original_env_node = System.get_env("EBB_TAILSCALE_NODE")
      original_env_bin = System.get_env("EBB_TAILSCALE_PROXY_BIN")

      System.delete_env("EBB_TAILSCALE_NODE")
      System.delete_env("EBB_TAILSCALE_PROXY_BIN")
      Application.delete_env(:ebb_server, :tailscale_node)
      Application.delete_env(:ebb_server, :tailscale_proxy_bin)
      Application.delete_env(:ebb_server, :tailscale_proxy_secret)

      dir = Path.join(System.tmp_dir!(), "ebb_ts_app_#{System.unique_integer([:positive])}")
      File.mkdir_p!(dir)
      bin = Path.join(dir, "ebb_tsnode")
      File.write!(bin, "#!/bin/sh\nexit 0\n")
      File.chmod!(bin, 0o755)

      on_exit(fn ->
        restore_env(:ebb_server, :tailscale_node, original_node)
        restore_env(:ebb_server, :tailscale_proxy_bin, original_bin)
        restore_env(:ebb_server, :tailscale_proxy_secret, original_secret)
        restore_env_var("EBB_TAILSCALE_NODE", original_env_node)
        restore_env_var("EBB_TAILSCALE_PROXY_BIN", original_env_bin)
        File.rm_rf(dir)
      end)

      %{bin: bin, data_dir: dir}
    end

    test "embedded mode mints a proxy secret and adds the gateway child", %{
      bin: bin,
      data_dir: dir
    } do
      System.put_env("EBB_TAILSCALE_NODE", "embedded")
      System.put_env("EBB_TAILSCALE_PROXY_BIN", bin)

      assert [{EbbServer.Tailscale.Node, opts}] =
               EbbServer.Application.resolve_tailscale!(dir, 4000)

      secret = Application.get_env(:ebb_server, :tailscale_proxy_secret)
      assert byte_size(Base.url_decode64!(secret, padding: false)) == 32
      assert opts[:config].proxy_secret == secret
      assert opts[:config].backend_addr == "127.0.0.1:4000"
    end

    test "keeps a secret that is already configured", %{bin: bin, data_dir: dir} do
      System.put_env("EBB_TAILSCALE_NODE", "embedded")
      System.put_env("EBB_TAILSCALE_PROXY_BIN", bin)
      Application.put_env(:ebb_server, :tailscale_proxy_secret, "operator-secret")

      assert [{EbbServer.Tailscale.Node, opts}] =
               EbbServer.Application.resolve_tailscale!(dir, 4000)

      assert Application.get_env(:ebb_server, :tailscale_proxy_secret) == "operator-secret"
      assert opts[:config].proxy_secret == "operator-secret"
    end

    test "fails the boot instead of replacing an invalid secret", %{bin: bin, data_dir: dir} do
      System.put_env("EBB_TAILSCALE_NODE", "embedded")
      System.put_env("EBB_TAILSCALE_PROXY_BIN", bin)
      Application.put_env(:ebb_server, :tailscale_proxy_secret, "")

      capture_io(:stderr, fn ->
        assert_raise RuntimeError, ~r/tailscale_proxy_secret/, fn ->
          EbbServer.Application.resolve_tailscale!(dir, 4000)
        end
      end)
    end

    test "writes the boot failure to stderr before raising", %{data_dir: dir} do
      System.put_env("EBB_TAILSCALE_NODE", "embedded")
      System.put_env("EBB_TAILSCALE_PROXY_BIN", "/nonexistent/ebb_tsnode")

      stderr =
        capture_io(:stderr, fn ->
          assert_raise RuntimeError, ~r/EBB_TAILSCALE_PROXY_BIN/, fn ->
            EbbServer.Application.resolve_tailscale!(dir, 4000)
          end
        end)

      assert stderr =~ "ebb_server boot failed:"
    end

    test "external mode starts no child and mints no secret", %{data_dir: dir} do
      System.put_env("EBB_TAILSCALE_NODE", "external")

      assert EbbServer.Application.resolve_tailscale!(dir, 4000) == []
      assert Application.get_env(:ebb_server, :tailscale_proxy_secret) == nil
    end
  end

  test "the suite resolves an external tailscale node so it never spawns the gateway" do
    assert Application.get_env(:ebb_server, :tailscale_node) == :external
  end

  # `Application.put_env/3` rejects nil; `System.put_env/2` treats nil as
  # delete. The two restore helpers bridge that asymmetry so we can
  # restore an "unset" snapshot without crashing the on_exit callback.
  defp restore_env(app, key, nil), do: Application.delete_env(app, key)
  defp restore_env(app, key, value), do: Application.put_env(app, key, value)

  defp restore_env_var(key, nil), do: System.delete_env(key)
  defp restore_env_var(key, value), do: System.put_env(key, value)
end
