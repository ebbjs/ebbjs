defmodule EbbServer.Sync.Router do
  @moduledoc """
  HTTP router for the EbbServer sync API.

  Provides two endpoints:
  - POST /sync/actions — Write actions to the system
  - GET /entities/:id — Read an entity by ID

  Returns appropriate HTTP status codes for various error conditions.
  """

  use Plug.Router

  alias EbbServer.Storage.{EntityStore, Writer, PermissionChecker}

  plug(Plug.Logger)
  plug(EbbServer.Sync.AuthPlug)
  plug(:match)
  plug(:dispatch)

  post "/sync/actions" do
    {:ok, body, conn} = Plug.Conn.read_body(conn)
    actor_id = conn.assigns.actor_id

    case decode_msgpack(body) do
      {:ok, actions} ->
        {accepted, pc_rejected} = PermissionChecker.validate_and_authorize(actions, actor_id)

        if accepted == [] do
          send_json(conn, 200, %{"rejected" => format_rejections(pc_rejected)})
        else
          case Writer.write_actions(accepted) do
            {:ok, _gsn_range, writer_rejected} ->
              all_rejected =
                format_rejections(pc_rejected) ++ format_writer_rejections(writer_rejected)

              send_json(conn, 200, %{"rejected" => all_rejected})

            {:error, _reason} ->
              send_json(conn, 503, %{"error" => "write_failed"})
          end
        end

      {:error, error_type, reason} ->
        send_error(conn, error_type, reason)
    end
  end

  get "/entities/:id" do
    conn = Plug.Conn.fetch_query_params(conn)
    entity_id = conn.path_params["id"]
    actor_id = conn.assigns[:actor_id] || conn.query_params["actor_id"]

    case actor_id do
      nil ->
        send_json(conn, 400, %{"error" => "actor_id required"})

      actor_id ->
        case EntityStore.get(entity_id, actor_id) do
          {:ok, entity} ->
            response = %{
              "id" => entity.id,
              "type" => entity.type,
              "data" => entity.data,
              "created_hlc" => entity.created_hlc,
              "updated_hlc" => entity.updated_hlc,
              "deleted_hlc" => entity.deleted_hlc,
              "last_gsn" => entity.last_gsn
            }

            send_json(conn, 200, response)

          :not_found ->
            send_json(conn, 404, %{"error" => "not_found"})

          {:error, :materialization_failed} ->
            send_json(conn, 503, %{"error" => "materialization_failed"})
        end
    end
  end

  match _ do
    send_resp(conn, 404, "")
  end

  defp decode_msgpack(<<>>) do
    {:error, :invalid_msgpack, "empty body"}
  end

  defp decode_msgpack(body) do
    case Msgpax.unpack(body) do
      {:ok, %{"actions" => actions}} when is_list(actions) ->
        {:ok, actions}

      {:ok, _} ->
        {:error, :invalid_msgpack, "actions key is required and must be a list"}

      {:error, reason} ->
        {:error, :invalid_msgpack, reason}
    end
  end

  defp format_rejections(rejections) do
    Enum.map(rejections, fn %{action_id: id, reason: reason, details: details} ->
      rejection = %{"id" => id, "reason" => reason}
      if details, do: Map.put(rejection, "details", details), else: rejection
    end)
  end

  defp format_writer_rejections(rejections) do
    Enum.map(rejections, fn %{action: action, reason: reason} ->
      %{"id" => action.id, "reason" => reason}
    end)
  end

  defp send_error(conn, :invalid_msgpack, _reason) do
    send_json(conn, 422, %{"error" => "invalid_msgpack"})
  end

  defp send_json(conn, status, body) do
    case Jason.encode(body) do
      {:ok, json} ->
        conn
        |> Plug.Conn.put_resp_content_type("application/json")
        |> Plug.Conn.send_resp(status, json)
        |> halt()

      {:error, _} ->
        conn
        |> Plug.Conn.put_resp_content_type("application/json")
        |> Plug.Conn.send_resp(500, ~s({"error": "encoding_failed"}))
        |> halt()
    end
  end
end
