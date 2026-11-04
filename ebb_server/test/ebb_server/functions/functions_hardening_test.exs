defmodule EbbServer.Functions.HardeningTest do
  use ExUnit.Case, async: false

  import Plug.Test

  alias EbbServer.Functions
  alias EbbServer.Functions.{Access, Principal}
  alias EbbServer.Functions.Worker.{Bun, Fake}

  @enabled_env "EBB_FUNCTIONS_ENABLED"
  @admin_env "EBB_FUNCTIONS_ADMIN_TOKEN"
  @secret_env "EBB_TEST_FUNCTIONS_SECRET"

  setup do
    previous = Application.get_env(:ebb_server, :functions)

    envs = Enum.map([@enabled_env, @admin_env, @secret_env], &{&1, System.get_env(&1)})

    on_exit(fn ->
      case previous do
        nil -> Application.delete_env(:ebb_server, :functions)
        value -> Application.put_env(:ebb_server, :functions, value)
      end

      Enum.each(envs, fn
        {key, nil} -> System.delete_env(key)
        {key, value} -> System.put_env(key, value)
      end)
    end)

    :ok
  end

  # Merge over the suite's base so a test that only changes `enabled` keeps the
  # fake transport and never trips the Bun boot check by accident.
  defp configure(config) do
    base = Application.get_env(:ebb_server, :functions, [])
    Application.put_env(:ebb_server, :functions, Keyword.merge(base, config))
  end

  defp service(opts) do
    Map.merge(
      %{
        id: "svc_test",
        token_sha256: :crypto.hash(:sha256, "secret-token") |> Base.encode16(case: :lower),
        subject_actor_id: "svc_actor",
        permissions: ["function.greet"]
      },
      Map.new(opts)
    )
  end

  describe "the admin credential" do
    test "EBB_FUNCTIONS_ADMIN_TOKEN wins over the compiled value" do
      configure(admin_token: "compiled")
      System.put_env(@admin_env, "runtime")

      assert :ok = Functions.resolve!()
      assert Functions.admin_token() == "runtime"
    end

    test "a blank environment value falls back to the compiled value" do
      configure(admin_token: "compiled")
      System.put_env(@admin_env, "   ")

      assert :ok = Functions.resolve!()
      assert Functions.admin_token() == "compiled"
    end

    test "an absent value on both sides is no credential" do
      configure(admin_token: "")
      System.delete_env(@admin_env)

      assert :ok = Functions.resolve!()
      assert Functions.admin_token() == nil
    end
  end

  describe "secrets" do
    test "are resolved at boot and never re-read per invocation" do
      configure(env: %{"greet" => [@secret_env]})
      System.put_env(@secret_env, "s3cret")

      assert :ok = Functions.resolve!()
      assert Functions.invocation_env("greet") == {:ok, %{@secret_env => "s3cret"}}

      System.put_env(@secret_env, "changed")
      assert Functions.invocation_env("greet") == {:ok, %{@secret_env => "s3cret"}}
    end

    test "a key with no value is missing, and blank counts as no value" do
      configure(env: %{"greet" => [@secret_env]})
      System.put_env(@secret_env, "")

      assert :ok = Functions.resolve!()

      assert Functions.invocation_env("greet") ==
               {:error, {:missing_secret, [@secret_env]}}
    end

    test "a function with no env entry gets an empty map" do
      configure(env: %{})
      assert :ok = Functions.resolve!()

      assert Functions.invocation_env("anything") == {:ok, %{}}
    end

    test "a malformed env map fails boot" do
      configure(env: %{"greet" => "NOT_A_LIST"})

      assert_raise RuntimeError, ~r/env must map a function name to a list/, fn ->
        Functions.resolve!()
      end
    end
  end

  describe "service credentials" do
    test "are normalized at boot" do
      configure(services: [service([])])

      assert :ok = Functions.resolve!()
      assert [%{id: "svc_test", subject_actor_id: "svc_actor"}] = Functions.services()
    end

    test "a token that is not a sha256 digest fails boot" do
      configure(services: [service(token_sha256: "plaintext")])

      assert_raise RuntimeError, ~r/token_sha256/, fn -> Functions.resolve!() end
    end

    test "resolve compares the presented token in constant time" do
      services = [service([])]

      conn =
        conn(:post, "/functions/greet")
        |> Plug.Conn.put_req_header("x-ebb-service-token", "secret-token")

      assert {:ok, principal} = Principal.resolve(conn, services: services)
      assert principal.kind == :service
      assert principal.actor_id == "svc_actor"
      assert principal.id == "svc:svc_test"
    end

    test "an unrecognized token is denied, never treated as an actor" do
      services = [service([])]

      conn =
        conn(:post, "/functions/greet")
        |> Plug.Conn.put_req_header("x-ebb-service-token", "wrong")
        |> Plug.Conn.assign(:actor_id, "a_someone")

      assert Principal.resolve(conn, services: services) == {:error, :denied}
    end

    test "a repeated service token header is denied" do
      services = [service([])]

      conn =
        conn(:post, "/functions/greet")
        |> Plug.Conn.put_req_header("x-ebb-service-token", "secret-token")
        |> Plug.Conn.prepend_req_headers([{"x-ebb-service-token", "secret-token"}])

      assert Principal.resolve(conn, services: services) == {:error, :denied}
    end

    test "a resolved actor is the actor principal when no service token is present" do
      conn =
        conn(:post, "/functions/greet")
        |> Plug.Conn.assign(:actor_id, "a_person")

      assert {:ok, %{kind: :actor, actor_id: "a_person", permissions: nil}} =
               Principal.resolve(conn, services: [])
    end
  end

  describe "access for a service principal" do
    defp service_principal(permissions) do
      %{kind: :service, id: "svc:test", actor_id: "actor", permissions: permissions}
    end

    test "a literal grant admits the invocation" do
      assert Access.authorize("granted", service_principal(["function.greet"]), "greet") == :ok
    end

    test "function.* admits every name" do
      assert Access.authorize("granted", service_principal(["function.*"]), "anything") == :ok
    end

    test "no grant is denied" do
      assert Access.authorize("granted", service_principal(["function.other"]), "greet") ==
               {:error, :denied}
    end

    test "access: authenticated admits a service with no grants" do
      assert Access.authorize("authenticated", service_principal([]), "greet") == :ok
    end
  end

  describe "limits" do
    test "carry the documented defaults" do
      configure([])

      assert Functions.max_invoke_body_bytes() == 256 * 1024
      assert Functions.max_host_calls() == 1_000
      assert Functions.max_log_lines() == 200
      assert Functions.max_log_bytes() == 64 * 1024
      assert Functions.fetch_allowlist() == []
      assert Functions.queue_limit() == 20

      limits = Functions.limits()
      assert limits["max_host_calls"] == 1_000
      assert limits["fetch_allowlist"] == []
    end

    test "read a configured value" do
      configure(
        max_invoke_body_bytes: 1_024,
        max_host_calls: 5,
        max_log_lines: 2,
        max_log_bytes: 16,
        fetch_allowlist: ["api.example.com"]
      )

      assert Functions.max_invoke_body_bytes() == 1_024
      assert Functions.limits()["fetch_allowlist"] == ["api.example.com"]

      configure(fetch_allowlist: ["api.example.com", :not_a_host])
      assert Functions.fetch_allowlist() == ["api.example.com"]
    end
  end

  describe "the pool defaults" do
    test "is on for the Bun transport and off for the fake" do
      configure(transport: Bun)
      assert Functions.pool?()
      assert Functions.pool_size() == min(4, System.schedulers_online())

      configure(transport: Fake)
      refute Functions.pool?()

      configure(transport: Bun, pool: false)
      refute Functions.pool?()
    end
  end

  describe "the boot check" do
    test "fails when the Bun runner bundle is missing" do
      configure(
        enabled: true,
        transport: Bun,
        worker_opts: [runner_path: "/definitely/missing/main.js"]
      )

      assert_raise RuntimeError, ~r/runner file is missing/, fn -> Functions.children() end
    end

    test "fails when Bun is not on the path" do
      runner = Path.join(System.tmp_dir!(), "ebb_runner_#{System.unique_integer([:positive])}.js")
      File.write!(runner, "")
      on_exit(fn -> File.rm(runner) end)

      configure(
        enabled: true,
        transport: Bun,
        worker_opts: [runner_path: runner, bun_path: "/definitely/missing/bun"]
      )

      assert_raise RuntimeError,
                   ~r/bun executable is missing or not runnable|bun was not found/,
                   fn ->
                     Functions.children()
                   end
    end
  end
end
