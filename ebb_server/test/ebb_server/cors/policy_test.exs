defmodule EbbServer.CORS.PolicyTest do
  @moduledoc """
  Pins the mode-aware CORS default and the static-origin parsing.
  """

  use ExUnit.Case, async: false

  alias EbbServer.CORS.Policy

  @origins_env "EBB_CORS_ORIGINS"
  @allow_any_env "EBB_CORS_ALLOW_ANY"

  setup do
    previous = Application.get_env(:ebb_server, :cors)
    envs = Enum.map([@origins_env, @allow_any_env], &{&1, System.get_env(&1)})
    Enum.each([@origins_env, @allow_any_env], &System.delete_env/1)
    Application.delete_env(:ebb_server, :cors)

    on_exit(fn ->
      restore_config(previous)

      Enum.each(envs, fn
        {key, nil} -> System.delete_env(key)
        {key, value} -> System.put_env(key, value)
      end)
    end)

    :ok
  end

  describe "the mode default" do
    test "bypass admits any origin; external and tailscale deny" do
      assert Policy.resolve!(:bypass).allow_any
      refute Policy.resolve!(:external).allow_any
      refute Policy.resolve!(:tailscale).allow_any
    end

    test "tailscale denies * but keeps configured origins" do
      System.put_env(@origins_env, "https://notes.example.com")

      assert %{allow_any: false, origins: ["https://notes.example.com"]} =
               Policy.resolve!(:tailscale)
    end

    test "EBB_CORS_ALLOW_ANY overrides the mode in both directions" do
      System.put_env(@allow_any_env, "1")
      assert Policy.resolve!(:tailscale).allow_any

      System.put_env(@allow_any_env, "true")
      assert Policy.resolve!(:external).allow_any

      System.put_env(@allow_any_env, "0")
      refute Policy.resolve!(:bypass).allow_any

      System.put_env(@allow_any_env, "false")
      refute Policy.resolve!(:bypass).allow_any
    end

    test "a blank value counts as unset" do
      System.put_env(@allow_any_env, "   ")
      assert Policy.resolve!(:bypass).allow_any
    end

    test "an unparseable value fails boot" do
      System.put_env(@allow_any_env, "yes")

      assert_raise RuntimeError, ~r/EBB_CORS_ALLOW_ANY must be one of/, fn ->
        Policy.resolve!(:external)
      end
    end
  end

  describe "EBB_CORS_ORIGINS" do
    test "normalizes, deduplicates, and keeps order" do
      System.put_env(
        @origins_env,
        "https://B.example.com:443, http://localhost:5173 ,https://b.example.com,"
      )

      assert Policy.resolve!(:external).origins == [
               "https://b.example.com",
               "http://localhost:5173"
             ]
    end

    test "is empty when unset or blank" do
      assert Policy.resolve!(:external).origins == []
      System.put_env(@origins_env, "  ")
      assert Policy.resolve!(:external).origins == []
    end

    test "an invalid origin fails boot instead of being skipped" do
      System.put_env(@origins_env, "https://ok.example.com,null")

      assert_raise RuntimeError, ~r/EBB_CORS_ORIGINS contains an invalid origin/, fn ->
        Policy.resolve!(:external)
      end
    end
  end

  describe "current/0" do
    test "is deny-all before resolve!" do
      assert Policy.current() == %{allow_any: false, origins: []}
    end

    test "reads the resolved policy without touching the environment" do
      System.put_env(@allow_any_env, "1")
      System.put_env(@origins_env, "https://a.example.com")

      assert %{allow_any: true, origins: ["https://a.example.com"]} =
               Policy.resolve!(:external)

      System.delete_env(@allow_any_env)
      System.delete_env(@origins_env)

      assert Policy.current() == %{allow_any: true, origins: ["https://a.example.com"]}
    end
  end

  defp restore_config(nil), do: Application.delete_env(:ebb_server, :cors)
  defp restore_config(value), do: Application.put_env(:ebb_server, :cors, value)
end
