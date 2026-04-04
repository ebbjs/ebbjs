defmodule EbbServer.Sync.Router do
  @moduledoc """
  HTTP router for the EbbServer sync API.

  Provides two endpoints:
  - POST /sync/actions — Write actions to the system
  - GET /entities/:id — Read an entity by ID

  Returns appropriate HTTP status codes for various error conditions.
  """

  use Plug.Router

  alias EbbServer.Storage.{EntityStore, Writer}

  plug(Plug.Logger)
  plug(:match)
  plug(:dispatch)

  post "/sync/actions" do
    {:ok, body, conn} = Plug.Conn.read_body(conn)

    case decode_and_validate(body) do
      {:valid, actions} ->
        write_and_respond(conn, actions)

      {:invalid, details} ->
        send_validation_error(conn, details)

      {:error, error_type, reason} ->
        send_error(conn, error_type, reason)
    end
  end

  get "/entities/:id" do
    conn = Plug.Conn.fetch_query_params(conn)
    entity_id = conn.path_params["id"]

    case conn.query_params["actor_id"] do
      nil ->
        send_json(conn, 400, %{"error" => "actor_id query parameter required"})

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

  defp decode_and_validate(<<>>) do
    {:error, :invalid_msgpack, "empty body"}
  end

  defp decode_and_validate(body) do
    case Msgpax.unpack(body) do
      {:ok, decoded} ->
        extract_and_validate_actions(decoded)

      {:error, reason} ->
        {:error, :invalid_msgpack, reason}
    end
  end

  defp extract_and_validate_actions(decoded) do
    case Map.fetch(decoded, "actions") do
      {:ok, actions} ->
        case validate_actions_list(actions) do
          :ok -> {:valid, actions}
          {:error, details} -> {:invalid, details}
        end

      :error ->
        {:invalid, [{"root", "actions key is required"}]}
    end
  end

  defp validate_actions_list(actions) when is_list(actions) do
    errors =
      actions
      |> Enum.with_index()
      |> Enum.flat_map(fn {action, index} ->
        action_errors(index, action)
      end)

    if errors == [],
      do: :ok,
      else: {:error, errors}
  end

  defp validate_actions_list(_),
    do: {:error, [{"root", "actions must be a list"}]}

  defp action_errors(index, action) when is_map(action) do
    [
      validate_action_id(action, index),
      validate_action_actor_id(action, index),
      validate_action_hlc(action, index),
      validate_action_updates(action, index)
    ]
    |> Enum.concat()
  end

  defp action_errors(index, _action),
    do: [{"#{index}", "must be a map"}]

  defp validate_action_id(action, index) do
    if is_binary(action["id"]) && action["id"] != "",
      do: [],
      else: [{"#{index}.id", "must be a non-empty string"}]
  end

  defp validate_action_actor_id(action, index) do
    if is_binary(action["actor_id"]) && action["actor_id"] != "",
      do: [],
      else: [{"#{index}.actor_id", "must be a non-empty string"}]
  end

  defp validate_action_hlc(action, index) do
    hlc = action["hlc"]

    hlc_valid =
      (is_integer(hlc) and hlc > 0) or
        (is_binary(hlc) and match?({int, ""} when int > 0, Integer.parse(hlc)))

    if hlc_valid,
      do: [],
      else: [{"#{index}.hlc", "must be a positive integer"}]
  end

  defp validate_action_updates(action, index) do
    if is_list(action["updates"]) do
      action["updates"]
      |> Enum.with_index()
      |> Enum.flat_map(fn {update, uidx} ->
        update_errors("#{index}.updates[#{uidx}]", update)
      end)
    else
      [{"#{index}.updates", "must be a list"}]
    end
  end

  defp update_errors(path, update) when is_map(update) do
    [
      validate_update_id(update, path),
      validate_update_subject_id(update, path),
      validate_update_subject_type(update, path),
      validate_update_method(update, path),
      validate_update_data(update, path)
    ]
    |> Enum.concat()
  end

  defp update_errors(path, _update),
    do: [{"#{path}", "must be a map"}]

  defp validate_update_id(update, path) do
    if is_binary(update["id"]) && update["id"] != "",
      do: [],
      else: [{"#{path}.id", "must be a non-empty string"}]
  end

  defp validate_update_subject_id(update, path) do
    if is_binary(update["subject_id"]) && update["subject_id"] != "",
      do: [],
      else: [{"#{path}.subject_id", "must be a non-empty string"}]
  end

  defp validate_update_subject_type(update, path) do
    if is_binary(update["subject_type"]) && update["subject_type"] != "",
      do: [],
      else: [{"#{path}.subject_type", "must be a non-empty string"}]
  end

  defp validate_update_method(update, path) do
    if update["method"] in ["put", "patch", "delete"],
      do: [],
      else: [{"#{path}.method", "must be one of: put, patch, delete"}]
  end

  defp validate_update_data(update, path) do
    cond do
      not is_map(update["data"]) ->
        [{"#{path}.data", "must be a map"}]

      update["method"] in ["put", "patch"] and not is_map(update["data"]["fields"]) ->
        [{"#{path}.data.fields", "must be a map for put/patch"}]

      true ->
        []
    end
  end

  defp write_and_respond(conn, actions) do
    case Writer.write_actions(actions) do
      {:ok, _gsn_range, rejected} ->
        rejected_json =
          Enum.map(rejected, fn %{action: action, reason: reason} ->
            %{"id" => action["id"], "reason" => reason}
          end)

        send_json(conn, 200, %{"rejected" => rejected_json})

      {:error, _reason} ->
        send_json(conn, 503, %{"error" => "write_failed"})
    end
  end

  defp send_validation_error(conn, details) do
    serializable_details =
      Enum.map(details, fn {field, msg} ->
        %{"field" => field, "message" => msg}
      end)

    send_json(conn, 422, %{"error" => "validation_failed", "details" => serializable_details})
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
