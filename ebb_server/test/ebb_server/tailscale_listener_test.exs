defmodule EbbServer.TailscaleListenerTest do
  @moduledoc """
  Drives the listener `EbbServer.Application` builds for tailscale mode: the
  address it actually binds and the identity route over a real socket.

  `RuntimeConfigTest` covers the pure resolution; this covers the wiring, so a
  changed Bandit option key or a lost `ip:` cannot pass the suite.
  """

  use ExUnit.Case, async: false

  setup do
    original_mode = Application.get_env(:ebb_server, :auth_mode)
    Application.put_env(:ebb_server, :auth_mode, :tailscale)

    on_exit(fn ->
      if original_mode,
        do: Application.put_env(:ebb_server, :auth_mode, original_mode),
        else: Application.delete_env(:ebb_server, :auth_mode)
    end)

    :ok
  end

  test "the tailscale listener binds loopback and serves the identity route" do
    {:ok, server} = Bandit.start_link(EbbServer.Application.bandit_options(0, :tailscale))
    {:ok, {address, port}} = ThousandIsland.listener_info(server)

    assert address == {127, 0, 0, 1}
    base = "http://127.0.0.1:#{port}"

    assert %Req.Response{status: 401} = Req.get!(base <> "/sync/identity")

    assert %Req.Response{status: 200, body: body} =
             Req.get!(base <> "/sync/identity",
               headers: [
                 {"tailscale-user-login", "alice@example.com"},
                 {"tailscale-user-name", "Alice"}
               ]
             )

    assert body == %{
             "actor_id" => "alice@example.com",
             "display_name" => "Alice",
             "provider" => "tailscale"
           }

    # The readiness probe depends on storage the suite owns, so assert only
    # that the route answers over this listener.
    assert %Req.Response{status: status} = Req.get!(base <> "/healthz")
    assert status in [200, 503]
  end
end
