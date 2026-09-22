defmodule EbbServer.RuntimeConfigTest do
  use ExUnit.Case, async: false

  setup do
    original_app_port = Application.get_env(:ebb_server, :port)
    original_env = System.get_env("EBB_PORT")

    on_exit(fn ->
      restore_env(:ebb_server, :port, original_app_port)
      restore_env_var("EBB_PORT", original_env)
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

  # `Application.put_env/3` rejects nil; `System.put_env/2` treats nil as
  # delete. The two restore helpers bridge that asymmetry so we can
  # restore an "unset" snapshot without crashing the on_exit callback.
  defp restore_env(app, key, nil), do: Application.delete_env(app, key)
  defp restore_env(app, key, value), do: Application.put_env(app, key, value)

  defp restore_env_var(_key, nil), do: System.delete_env("EBB_PORT")
  defp restore_env_var(key, value), do: System.put_env(key, value)
end
