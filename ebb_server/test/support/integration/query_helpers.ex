defmodule EbbServer.Integration.QueryHelpers do
  @moduledoc """
  Shared helper functions for integration tests that query entities.
  """

  import Plug.Test
  import Plug.Conn

  alias EbbServer.Sync.Router

  def post_query(body, actor_id) do
    conn(:post, "/entities/query", Jason.encode!(body))
    |> put_req_header("content-type", "application/json")
    |> put_req_header("x-ebb-actor-id", actor_id)
    |> Router.call([])
  end
end
