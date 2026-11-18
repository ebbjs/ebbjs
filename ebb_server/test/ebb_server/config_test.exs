defmodule EbbServer.ConfigTest do
  # Mutates the environment and `:ebb_server` application keys, which boot-time
  # resolution elsewhere in this suite also reads.
  use ExUnit.Case, async: false

  alias EbbServer.Config

  @env_name "EBB_TEST_CONFIG_VALUE"
  @missing_env "EBB_TEST_CONFIG_NEVER_SET"
  @data_dir_env "EBB_DATA_DIR"
  @app_key :config_test_value
  @source "EBB_TEST_FLAG"

  @truthy ~w(true 1 yes on TRUE Yes ON)
  @falsy ~w(false 0 no off FALSE No OFF)

  setup do
    original = %{
      env: System.get_env(@env_name),
      data_dir_env: System.get_env(@data_dir_env),
      app_value: Application.fetch_env(:ebb_server, @app_key),
      data_dir: Application.fetch_env(:ebb_server, :data_dir)
    }

    on_exit(fn -> restore(original) end)

    :ok
  end

  describe "env/1" do
    test "returns the trimmed value" do
      System.put_env(@env_name, "  value \t")

      assert Config.env(@env_name) == "value"
    end

    test "treats an unset variable as nil" do
      System.delete_env(@missing_env)

      assert Config.env(@missing_env) == nil
    end

    test "treats an empty or whitespace-only value as nil" do
      for blank <- ["", "   ", "\t\n "] do
        System.put_env(@env_name, blank)

        assert Config.env(@env_name) == nil
      end
    end
  end

  describe "env_over_app/2" do
    test "the environment wins over the application value" do
      Application.put_env(:ebb_server, @app_key, "compiled")
      System.put_env(@env_name, "runtime")

      assert Config.env_over_app(@env_name, @app_key) == "runtime"
    end

    test "falls back to the application value when the variable is unset" do
      System.delete_env(@env_name)
      Application.put_env(:ebb_server, @app_key, "compiled")

      assert Config.env_over_app(@env_name, @app_key) == "compiled"
    end

    test "a blank variable reads as unset, so the application value wins" do
      Application.put_env(:ebb_server, @app_key, "compiled")

      for blank <- ["", "   ", "\t"] do
        System.put_env(@env_name, blank)

        assert Config.env_over_app(@env_name, @app_key) == "compiled"
      end
    end

    test "a blank application value reads as unset" do
      System.delete_env(@env_name)
      Application.put_env(:ebb_server, @app_key, "  ")

      assert Config.env_over_app(@env_name, @app_key) == nil
    end

    test "returns nil when neither source is set" do
      System.delete_env(@env_name)
      Application.delete_env(:ebb_server, @app_key)

      assert Config.env_over_app(@env_name, @app_key) == nil
    end

    test "passes a non-string application value through unchanged" do
      System.delete_env(@env_name)
      Application.put_env(:ebb_server, @app_key, :atom_setting)

      assert Config.env_over_app(@env_name, @app_key) == :atom_setting
    end

    test "returns the environment value verbatim for the caller's own parser" do
      System.put_env(@env_name, "  Exact  ")

      assert Config.env_over_app(@env_name, @app_key) == "  Exact  "
    end
  end

  describe "boolean!/2" do
    test "accepts every spelling a caller already accepted, case-insensitively" do
      for raw <- @truthy do
        assert Config.boolean!(raw, @source) == true, "expected #{inspect(raw)} to be true"
      end

      for raw <- @falsy do
        assert Config.boolean!(raw, @source) == false, "expected #{inspect(raw)} to be false"
      end
    end

    test "ignores surrounding whitespace" do
      assert Config.boolean!("  yes\t", @source) == true
      assert Config.boolean!(" OFF \n", @source) == false
    end

    test "accepts the booleans an application value may hold" do
      assert Config.boolean!(true, @source) == true
      assert Config.boolean!(false, @source) == false
    end

    test "raises naming the source and every accepted spelling" do
      error = assert_raise RuntimeError, fn -> Config.boolean!("maybe", @source) end

      assert error.message =~ @source
      assert error.message =~ ~s("maybe")

      for accepted <- ~w(true 1 yes on false 0 no off) do
        assert error.message =~ accepted
      end
    end
  end

  describe "data_dir/0" do
    test "the compiled value wins over EBB_DATA_DIR" do
      Application.put_env(:ebb_server, :data_dir, "/compiled/data")
      System.put_env(@data_dir_env, "/volume/data")

      assert Config.data_dir() == "/compiled/data"
    end

    test "falls back to EBB_DATA_DIR" do
      Application.delete_env(:ebb_server, :data_dir)
      System.put_env(@data_dir_env, "/volume/data")

      assert Config.data_dir() == "/volume/data"
    end

    test "falls back to ./data when neither is set" do
      Application.delete_env(:ebb_server, :data_dir)
      System.delete_env(@data_dir_env)

      assert Config.data_dir() == "./data"
    end

    test "a blank EBB_DATA_DIR reads as unset" do
      Application.delete_env(:ebb_server, :data_dir)
      System.put_env(@data_dir_env, "   ")

      assert Config.data_dir() == "./data"
    end
  end

  defp restore(original) do
    restore_env(@env_name, original.env)
    restore_env(@data_dir_env, original.data_dir_env)
    restore_app(:ebb_server, @app_key, original.app_value)
    restore_app(:ebb_server, :data_dir, original.data_dir)
  end

  defp restore_env(name, nil), do: System.delete_env(name)
  defp restore_env(name, value), do: System.put_env(name, value)

  defp restore_app(app, key, :error), do: Application.delete_env(app, key)
  defp restore_app(app, key, {:ok, value}), do: Application.put_env(app, key, value)
end
