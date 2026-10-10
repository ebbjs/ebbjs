defmodule EbbServer.Telemetry.HTTPTest do
  # The HTTP translator emits global `:telemetry` events and the application
  # boots a globally-attached handler, so these tests must not run alongside
  # other modules' telemetry assertions.
  use ExUnit.Case, async: false

  import EbbServer.TestHelpers

  alias EbbServer.Telemetry.HTTP

  @event [:ebb, :http, :request_latency_ms]

  defmodule MockRouter do
    @moduledoc false
    use Plug.Router

    plug(:match)
    plug(:dispatch)

    get "/entities/:id" do
      send_resp(conn, 200, "ok")
    end

    post "/boom" do
      send_resp(conn, 503, "boom")
    end

    get "/sync/live" do
      send_resp(conn, 200, "live")
    end

    get "/raise" do
      _ = conn
      raise "boom"
    end
  end

  describe "handle_event/4" do
    test "emits latency with the matched plug route and the response status" do
      ref = attach_telemetry([@event])

      conn = %Plug.Conn{
        method: "GET",
        status: 200,
        private: %{plug_route: {"/entities/:id", noop_route_fun()}}
      }

      HTTP.handle_event(
        [:bandit, :request, :stop],
        %{duration: 42},
        %{telemetry_span_context: make_ref(), conn: conn},
        nil
      )

      assert [
               {@event, %{duration: duration},
                %{method: "GET", route: "/entities/:id", status: 200}}
             ] =
               telemetry_events(ref)

      assert is_integer(duration)
    end

    test "falls back to the request path when no plug route matched" do
      ref = attach_telemetry([@event])
      conn = %Plug.Conn{method: "POST", request_path: "/entities/abc", status: 404, private: %{}}

      HTTP.handle_event(
        [:bandit, :request, :stop],
        %{duration: 7},
        %{telemetry_span_context: make_ref(), conn: conn},
        nil
      )

      assert [{@event, %{duration: 7}, %{method: "POST", route: "/entities/abc", status: 404}}] =
               telemetry_events(ref)
    end

    test "emits nothing for the SSE route" do
      ref = attach_telemetry([@event])

      conn = %Plug.Conn{
        method: "GET",
        status: 200,
        private: %{plug_route: {"/sync/live", noop_route_fun()}}
      }

      HTTP.handle_event(
        [:bandit, :request, :stop],
        %{duration: 9_000_000},
        %{telemetry_span_context: make_ref(), conn: conn},
        nil
      )

      assert telemetry_events(ref) == []
    end

    test "reports 500 when the conn never committed a status" do
      ref = attach_telemetry([@event])
      conn = %Plug.Conn{method: "GET", request_path: "/boom", status: nil, private: %{}}

      HTTP.handle_event(
        [:bandit, :request, :stop],
        %{duration: 1},
        %{telemetry_span_context: make_ref(), conn: conn},
        nil
      )

      assert [{@event, %{duration: 1}, %{method: "GET", route: "/boom", status: 500}}] =
               telemetry_events(ref)
    end

    test "measures an exception against the recorded start" do
      ref = attach_telemetry([@event])
      span_context = make_ref()
      conn = %Plug.Conn{method: "GET", request_path: "/boom", private: %{}}
      metadata = %{telemetry_span_context: span_context, conn: conn}

      HTTP.handle_event(
        [:bandit, :request, :start],
        %{monotonic_time: System.monotonic_time()},
        metadata,
        nil
      )

      HTTP.handle_event(
        [:bandit, :request, :exception],
        %{monotonic_time: System.monotonic_time()},
        metadata,
        nil
      )

      assert [{@event, %{duration: duration}, %{method: "GET", route: "/boom", status: 500}}] =
               telemetry_events(ref)

      assert is_integer(duration)
      assert duration >= 0
    end

    test "emits unknown labels when Bandit could not build a conn" do
      ref = attach_telemetry([@event])

      HTTP.handle_event(
        [:bandit, :request, :stop],
        %{duration: 3},
        %{telemetry_span_context: make_ref()},
        nil
      )

      assert [{@event, %{duration: 3}, %{method: "unknown", route: "unknown", status: 500}}] =
               telemetry_events(ref)
    end
  end

  describe "start_link/1" do
    test "returns :ignore and starts no process when disabled" do
      name = :"disabled_http_telemetry_#{System.unique_integer([:positive])}"

      assert :ignore = HTTP.start_link(enabled: false, name: name)
      assert Process.whereis(name) == nil
    end
  end

  describe "integration with Bandit" do
    setup do
      {:ok, server} = Bandit.start_link(plug: MockRouter, port: 0, scheme: :http)
      {:ok, {_ip, port}} = ThousandIsland.listener_info(server)

      on_exit(fn ->
        if Process.alive?(server), do: Process.exit(server, :normal)
      end)

      %{base_url: "http://localhost:#{port}"}
    end

    test "emits the real route and status for each completed request", %{base_url: base_url} do
      ref = attach_telemetry([@event])

      assert Req.get!(base_url <> "/entities/abc").status == 200
      assert Req.post!(base_url <> "/boom").status == 503

      events = telemetry_events(ref, 500)

      assert {@event, %{duration: get_duration},
              %{method: "GET", route: "/entities/:id", status: 200}} =
               Enum.find(events, &match?({_, _, %{route: "/entities/:id"}}, &1))

      assert is_integer(get_duration)

      assert {@event, %{duration: post_duration}, %{method: "POST", route: "/boom", status: 503}} =
               Enum.find(events, &match?({_, _, %{route: "/boom"}}, &1))

      assert is_integer(post_duration)
    end

    test "emits nothing for the SSE route", %{base_url: base_url} do
      ref = attach_telemetry([@event, [:bandit, :request, :stop]])

      assert Req.get!(base_url <> "/entities/abc").status == 200
      assert Req.get!(base_url <> "/sync/live").status == 200

      await_bandit_stop(ref, "/sync/live")

      events = telemetry_events(ref, 200)
      routes = for {@event, _measurements, metadata} <- events, do: metadata.route

      refute "/sync/live" in routes
      assert routes == ["/entities/:id"]
    end

    test "records a 500 for a request that raises", %{base_url: base_url} do
      ref = attach_telemetry([@event])

      assert Req.get!(base_url <> "/raise", retry: false).status == 500

      assert [{@event, %{duration: duration}, %{method: "GET", route: "/raise", status: 500}}] =
               telemetry_events(ref, 500)

      assert duration >= 0
    end
  end

  defp await_bandit_stop(ref, path) do
    receive do
      {:telemetry_event, ^ref, [:bandit, :request, :stop], _measurements, %{conn: conn}} ->
        if conn.request_path == path, do: :ok, else: await_bandit_stop(ref, path)
    after
      2_000 -> flunk("Bandit never finished the request for #{path}")
    end
  end

  defp noop_route_fun, do: fn _conn, _opts -> :ok end
end

defmodule EbbServer.Telemetry.HTTPRouterIntegrationTest do
  @moduledoc """
  The HTTP request metric records the real `EbbServer.Sync.Router`'s 503
  write-failure response (ebbjs/ebbjs#364).
  """

  use ExUnit.Case, async: false
  use EbbServer.Integration.StorageCase, with_auth_mode: true

  import EbbServer.TestHelpers

  alias EbbServer.Integration.ActionHelpers

  @event [:ebb, :http, :request_latency_ms]

  def storage_writer_opts do
    [commit_fn: fn _ops, _opts -> {:error, :injected_rocksdb_failure} end]
  end

  test "a failed write is sampled as status 503 through the real router" do
    actor_id = "a_364_fail_#{:erlang.unique_integer([:positive])}"
    group_id = "g_364_fail_#{:erlang.unique_integer([:positive])}"

    {:ok, server} = Bandit.start_link(plug: EbbServer.Sync.Router, port: 0, scheme: :http)
    {:ok, {_ip, port}} = ThousandIsland.listener_info(server)

    on_exit(fn ->
      if Process.alive?(server), do: Process.exit(server, :normal)
    end)

    ref = attach_telemetry([@event])

    body =
      %{"actions" => [ActionHelpers.bootstrap_group_action(actor_id, group_id, ["todo.*"])]}
      |> ActionHelpers.msgpack_encode!()

    response =
      Req.post!("http://localhost:#{port}/sync/actions",
        body: body,
        headers: [{"x-ebb-actor-id", actor_id}]
      )

    assert response.status == 503

    assert [
             {@event, %{duration: duration},
              %{method: "POST", route: "/sync/actions", status: 503}}
           ] =
             telemetry_events(ref, 1_000)

    assert is_integer(duration)
  end
end
