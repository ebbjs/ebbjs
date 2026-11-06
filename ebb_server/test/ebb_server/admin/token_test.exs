defmodule EbbServer.Admin.TokenTest do
  @moduledoc """
  Pins the promoted admin credential: its resolution order, the constant-time
  comparison shared by every admin surface, and the functions fallback.
  """

  use ExUnit.Case, async: false

  alias EbbServer.Admin.Token
  alias EbbServer.Functions

  @server_env "EBB_ADMIN_TOKEN"
  @functions_env "EBB_FUNCTIONS_ADMIN_TOKEN"

  setup do
    previous_functions = Application.get_env(:ebb_server, :functions)
    previous_server_token = Application.get_env(:ebb_server, :admin_token)

    envs = Enum.map([@server_env, @functions_env], &{&1, System.get_env(&1)})
    Enum.each([@server_env, @functions_env], &System.delete_env/1)
    Application.delete_env(:ebb_server, :admin_token)

    on_exit(fn ->
      restore_config(:functions, previous_functions)
      restore_config(:admin_token, previous_server_token)

      Enum.each(envs, fn
        {key, nil} -> System.delete_env(key)
        {key, value} -> System.put_env(key, value)
      end)
    end)

    :ok
  end

  describe "resolve!/0 precedence" do
    test "EBB_ADMIN_TOKEN wins over every other source" do
      System.put_env(@server_env, "from-server-env")
      System.put_env(@functions_env, "from-functions-env")
      Application.put_env(:ebb_server, :admin_token, "from-server-key")
      put_functions_token("from-functions-key")

      assert :ok = Token.resolve!()
      assert Token.value() == "from-server-env"
      assert Application.get_env(:ebb_server, :admin_token) == "from-server-env"
    end

    test "the server-level key wins over the functions fallback" do
      System.put_env(@functions_env, "from-functions-env")
      Application.put_env(:ebb_server, :admin_token, "from-server-key")
      put_functions_token("from-functions-key")

      assert :ok = Token.resolve!()
      assert Token.value() == "from-server-key"
    end

    test "EBB_FUNCTIONS_ADMIN_TOKEN is promoted when nothing higher is set" do
      System.put_env(@functions_env, "from-functions-env")
      put_functions_token("from-functions-key")

      assert :ok = Token.resolve!()
      assert Token.value() == "from-functions-env"
    end

    test "the functions key is the last fallback" do
      put_functions_token("from-functions-key")

      assert :ok = Token.resolve!()
      assert Token.value() == "from-functions-key"
    end

    test "blank values count as unset and no winner removes the key" do
      System.put_env(@server_env, "   ")
      System.put_env(@functions_env, "")
      put_functions_token("")

      assert :ok = Token.resolve!()
      assert Token.value() == nil
      assert Application.get_env(:ebb_server, :admin_token) == nil
    end
  end

  describe "value/0" do
    test "falls back to the functions key before resolve!/0 runs" do
      put_functions_token("from-functions-key")

      assert Token.value() == "from-functions-key"
    end
  end

  describe "authorize/2" do
    test "accepts a matching bearer credential, scheme case-insensitively" do
      assert :ok = Token.authorize(bearer("Bearer s3cret"), token: "s3cret")
      assert :ok = Token.authorize(bearer("bearer s3cret"), token: "s3cret")
    end

    test "denies a missing, malformed, duplicate, or wrong credential" do
      assert {:error, :denied} = Token.authorize(conn(), token: "s3cret")
      assert {:error, :denied} = Token.authorize(bearer("Basic s3cret"), token: "s3cret")
      assert {:error, :denied} = Token.authorize(bearer("Bearer"), token: "s3cret")
      assert {:error, :denied} = Token.authorize(bearer("Bearer wrong"), token: "s3cret")

      duplicated =
        Plug.Conn.prepend_req_headers(conn(), [
          {"authorization", "Bearer s3cret"},
          {"authorization", "Bearer s3cret"}
        ])

      assert {:error, :denied} = Token.authorize(duplicated, token: "s3cret")
    end

    test "reports a node with no credential separately, so routes can fail closed" do
      assert {:error, :not_configured} = Token.authorize(bearer("Bearer anything"))
      assert {:error, :not_configured} = Token.authorize(bearer("Bearer anything"), token: "  ")
    end
  end

  describe "the functions fallback" do
    test "Functions.admin_token/0 picks up EBB_ADMIN_TOKEN through resolve!" do
      System.put_env(@server_env, "promoted")
      put_functions_token("legacy")

      assert :ok = Token.resolve!()
      assert :ok = Functions.resolve!()
      assert Functions.admin_token() == "promoted"
    end

    test "Functions.Admin still denies rather than opening without a credential" do
      assert {:error, :denied} =
               EbbServer.Functions.Admin.authorize(bearer("Bearer anything"), admin_token: nil)
    end
  end

  defp bearer(value) do
    Plug.Conn.put_req_header(conn(), "authorization", value)
  end

  defp conn, do: Plug.Test.conn(:get, "/admin/apps")

  defp put_functions_token(token) do
    Application.put_env(
      :ebb_server,
      :functions,
      Keyword.put(Application.get_env(:ebb_server, :functions, []), :admin_token, token)
    )
  end

  defp restore_config(key, nil), do: Application.delete_env(:ebb_server, key)
  defp restore_config(key, value), do: Application.put_env(:ebb_server, key, value)
end
