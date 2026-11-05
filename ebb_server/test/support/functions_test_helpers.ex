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

  alias EbbServer.Functions.{Bundle, BundleCache, Host, Store}
  alias EbbServer.Functions.Bundle.StoreLoader
  alias EbbServer.Functions.Router, as: FunctionsRouter
  alias EbbServer.Functions.Worker.Bun, as: BunWorker
  alias EbbServer.Integration.ActionHelpers
  alias EbbServer.Storage.GroupCache
  alias EbbServer.Sync.Router
  alias EbbServer.TestFunctions.Bun, as: BunSupport

  @grant_group "g_functions_test"

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
    base = previous || []

    Application.put_env(
      :ebb_server,
      :functions,
      base |> Keyword.merge(enabled: true) |> Keyword.merge(overrides)
    )

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
  def configure_bun(dir, overrides \\ []) do
    configure_boot(
      Keyword.merge(
        [
          bundle_dir: dir,
          transport: BunWorker,
          worker_opts: BunSupport.transport_opts(dir)
        ],
        overrides
      )
    )
  end

  @doc "Starts the bundle cache over `dir` as the booted node would."
  def start_cache(dir) do
    ExUnit.Callbacks.start_supervised!({BundleCache, loader_opts: [dir: dir]})
  end

  @doc """
  Starts an isolated `Functions.Store` under `data_dir`.

  Unnamed, so a test that also starts the registered store never collides, and
  with its own supervisor id, so two stores in one test are two processes.
  """
  def start_store(data_dir) do
    ExUnit.Callbacks.start_supervised!(
      Supervisor.child_spec({Store, name: nil, data_dir: data_dir}, id: make_ref())
    )
  end

  @doc "Starts an isolated bundle cache reading `store` through `StoreLoader`."
  def start_store_cache(store) do
    ExUnit.Callbacks.start_supervised!(
      Supervisor.child_spec(
        {BundleCache, name: nil, loader: StoreLoader, loader_opts: [store: store]},
        id: make_ref()
      )
    )
  end

  @doc "Grants `permissions` to `actor_id` in the shared functions test group."
  def grant_function(tables, actor_id, permissions) do
    :ok =
      GroupCache.put_group_member(
        %{
          id: unique("gm"),
          actor_id: actor_id,
          group_id: @grant_group,
          permissions: permissions
        },
        group_members: tables.group_members,
        group_members_by_id: tables.group_members_by_id,
        group_members_by_group: tables.group_members_by_group
      )
  end

  @doc """
  Calls the functions router directly, with `path` relative to `/functions`.

  Identity and the admin credential are request-level: pass `:actor_id`
  (`nil` for an anonymous request) and `:authorization` (the raw header value).
  The router's own options are passed through unchanged: `:store`, `:cache`,
  `:group_members_table`, `:admin_token`.
  """
  def call_functions(method, path, body, opts \\ []) do
    conn(method, path, body)
    |> put_req_header("content-type", "application/json")
    |> EbbServer.TestHelpers.put_actor(Keyword.get(opts, :actor_id))
    |> put_optional_header("authorization", Keyword.get(opts, :authorization))
    |> put_request_headers(Keyword.get(opts, :headers, []))
    |> FunctionsRouter.call(FunctionsRouter.init(Keyword.take(opts, router_option_keys())))
  end

  @doc "The upload body for `envelope` and `code`, plus any extra top-level fields."
  def upload_body(envelope, code, extra \\ %{}) do
    Jason.encode!(Map.merge(%{"envelope" => envelope, "code" => code}, extra))
  end

  @doc "An envelope for `name` whose digest matches `code`."
  def envelope_for(name, code, overrides \\ %{}) do
    name
    |> EbbServer.TestFunctions.Bundles.envelope(%{"digest" => Bundle.digest_for(code)})
    |> Map.merge(overrides)
  end

  @doc "The decoded JSON body of a response."
  def json_body(conn), do: Jason.decode!(conn.resp_body)

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

  defp put_optional_header(conn, _name, nil), do: conn
  defp put_optional_header(conn, name, value), do: put_req_header(conn, name, value)

  defp router_option_keys, do: [:store, :cache, :group_members_table, :admin_token]
end
