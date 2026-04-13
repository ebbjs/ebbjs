defmodule EbbServer.Sync.Router do
  @moduledoc """
  HTTP router for the EbbServer sync API.

  Provides two endpoints:
  - POST /sync/actions — Write actions to the system
  - GET /entities/:id — Read an entity by ID

  Returns appropriate HTTP status codes for various error conditions.
  """

  use Plug.Router

  alias EbbServer.Storage.{EntityStore, GroupCache, PermissionChecker, WatermarkTracker, Writer}
  alias EbbServer.Sync.{CatchUp, SSEHandler}

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

  post "/entities/query" do
    {:ok, body, conn} = Plug.Conn.read_body(conn)
    actor_id = conn.assigns.actor_id

    case Jason.decode(body) do
      {:ok, %{"type" => type} = payload} when is_binary(type) and type != "" ->
        filter = payload["filter"]
        opts = []
        opts = if payload["limit"], do: [{:limit, payload["limit"]} | opts], else: opts
        opts = if payload["offset"], do: [{:offset, payload["offset"]} | opts], else: opts

        case EntityStore.query(type, filter, actor_id, opts) do
          {:ok, entities} ->
            response =
              Enum.map(entities, fn entity ->
                %{
                  "id" => entity.id,
                  "type" => entity.type,
                  "data" => entity.data,
                  "created_hlc" => entity.created_hlc,
                  "updated_hlc" => entity.updated_hlc,
                  "deleted_hlc" => entity.deleted_hlc,
                  "last_gsn" => entity.last_gsn
                }
              end)

            send_json(conn, 200, response)

          {:error, reason} ->
            send_json(conn, 503, %{"error" => "query_failed", "details" => inspect(reason)})
        end

      {:ok, _} ->
        send_json(conn, 422, %{
          "error" => "validation_failed",
          "details" => "type is required and must be a non-empty string"
        })

      {:error, _} ->
        send_json(conn, 422, %{"error" => "invalid_json"})
    end
  end

  post "/sync/handshake" do
    {:ok, body, conn} = Plug.Conn.read_body(conn)
    actor_id = conn.assigns.actor_id

    case Jason.decode(body) do
      {:ok, payload} ->
        _cursors = payload["cursors"] || %{}
        _schema_version = payload["schema_version"]

        groups = GroupCache.get_actor_groups(actor_id)

        response = %{
          "actor_id" => actor_id,
          "groups" =>
            Enum.map(groups, fn %{group_id: gid, permissions: perms} ->
              %{"id" => gid, "permissions" => perms}
            end)
        }

        send_json(conn, 200, response)

      {:error, _} ->
        send_json(conn, 422, %{"error" => "invalid_json"})
    end
  end

  get "/sync/live" do
    conn = Plug.Conn.fetch_query_params(conn)
    actor_id = conn.assigns.actor_id

    groups_param = conn.query_params["groups"] || ""
    cursor_param = conn.query_params["cursor"] || "0"

    group_ids = String.split(groups_param, ",", trim: true)

    case Integer.parse(cursor_param) do
      {cursor, ""} when cursor >= 0 and group_ids != [] ->
        case verify_all_group_membership(group_ids, actor_id) do
          :ok ->
            watermark = WatermarkTracker.committed_watermark()

            if cursor > watermark do
              SSEHandler.write_stale_cursor_response(conn, watermark + 1)
              {:stop, :normal}
            else
              case SSEHandler.open_sse(conn, group_ids, cursor, actor_id) do
                :ok -> {:stop, :normal}
                {:error, :not_member} -> send_json(conn, 403, %{"error" => "not_member"})
              end
            end

          {:error, :not_member} ->
            send_json(conn, 403, %{"error" => "not_member"})
        end

      _ ->
        send_json(conn, 400, %{"error" => "invalid_params"})
    end
  end

  get "/sync/groups/:group_id" do
    conn = Plug.Conn.fetch_query_params(conn)
    actor_id = conn.assigns.actor_id
    offset_str = conn.query_params["offset"] || "0"

    case Integer.parse(offset_str) do
      {offset, ""} when offset >= 0 ->
        case CatchUp.catch_up_group(group_id, actor_id, offset) do
          {:ok, actions, meta} ->
            conn
            |> maybe_put_resp_header("stream-next-offset", meta.next_offset)
            |> maybe_put_resp_header("stream-up-to-date", meta.up_to_date && "true")
            |> send_json_actions(200, actions)

          {:error, :not_member} ->
            send_json(conn, 403, %{"error" => "not_member"})
        end

      _ ->
        send_json(conn, 400, %{"error" => "invalid_offset"})
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

  defp maybe_put_resp_header(conn, _header, false), do: conn
  defp maybe_put_resp_header(conn, _header, nil), do: conn

  defp maybe_put_resp_header(conn, header, value) do
    Plug.Conn.put_resp_header(conn, header, to_string(value))
  end

  defp send_json_actions(conn, status, actions) do
    body =
      Enum.map(actions, fn action ->
        %{
          "id" => action["id"],
          "actor_id" => action["actor_id"],
          "hlc" => action["hlc"],
          "gsn" => action["gsn"],
          "updates" => action["updates"]
        }
      end)

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

  defp verify_all_group_membership(group_ids, actor_id) do
    non_member_groups =
      Enum.reject(group_ids, fn group_id ->
        GroupCache.get_permissions(actor_id, group_id) != nil
      end)

    if non_member_groups == [] do
      :ok
    else
      {:error, :not_member}
    end
  end
end
