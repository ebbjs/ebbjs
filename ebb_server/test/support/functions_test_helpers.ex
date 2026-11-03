defmodule EbbServer.FunctionsTestHelpers do
  @moduledoc """
  Request and setup helpers shared by the functions acceptance suites.

  The suites differ in which worker transport they configure — a scripted fake
  or a real Bun process — but they send the same requests through the same
  router and seed the same membership rows. Those pieces live here so a change
  to the route under test cannot be made in one suite and missed in another.
  """

  import ExUnit.Assertions
  import Plug.Conn
  import Plug.Test

  alias EbbServer.Functions.{BundleCache, Host}
  alias EbbServer.Functions.Worker.Bun, as: BunWorker
  alias EbbServer.Integration.ActionHelpers
  alias EbbServer.Sync.Router
  alias EbbServer.TestFunctions.Bun, as: BunSupport

  @doc "A value unique to this test run, prefixed for readability."
  def unique(prefix), do: "#{prefix}_#{System.unique_integer([:positive])}"

  @doc "Seeds a group and the actor's membership with the given permissions."
  def seed_member(actor_id, group_id, permissions) do
    assert ActionHelpers.bootstrap_group(actor_id, group_id, permissions).status == 200
  end

  @doc "A `todo.title` wire field."
  def fields(title) do
    hlc = EbbServer.TestHelpers.generate_hlc()
    %{"title" => %{"type" => "lww", "value" => title, "hlc" => hlc}}
  end

  @doc """
  Enables functions with `overrides` for the duration of the test.

  The flag reads the application environment, so the previous value is
  restored on exit whether or not the test passed.
  """
  def configure_boot(overrides) do
    previous = Application.get_env(:ebb_server, :functions)

    Application.put_env(:ebb_server, :functions, Keyword.merge([enabled: true], overrides))

    ExUnit.Callbacks.on_exit(fn ->
      case previous do
        nil -> Application.delete_env(:ebb_server, :functions)
        value -> Application.put_env(:ebb_server, :functions, value)
      end
    end)
  end

  @doc """
  Enables functions with the real Bun runner over `dir`.

  The socket directory is derived from the bundle directory, so each test gets
  its own set of runner sockets.
  """
  def configure_bun(dir) do
    configure_boot(
      bundle_dir: dir,
      transport: BunWorker,
      worker_opts: BunSupport.transport_opts(dir)
    )
  end

  @doc "Starts the bundle cache over `dir` as the booted node would."
  def start_cache(dir) do
    ExUnit.Callbacks.start_supervised!({BundleCache, loader_opts: [dir: dir]})
  end

  @doc "Posts to `POST /functions/:name` through the sync router."
  def post_function(name, body, actor_id, headers \\ []) do
    conn(:post, "/functions/#{name}", body)
    |> put_req_header("content-type", "application/json")
    |> put_req_header("x-ebb-actor-id", actor_id)
    |> put_request_headers(headers)
    |> Router.call([])
  end

  @doc "The derived Action id one invocation's commit carries."
  def action_id_for(invocation_id), do: Host.action_id(invocation_id)

  defp put_request_headers(conn, headers) do
    Enum.reduce(headers, conn, fn {name, value}, conn -> put_req_header(conn, name, value) end)
  end
end
