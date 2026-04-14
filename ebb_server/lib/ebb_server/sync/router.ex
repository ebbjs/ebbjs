defmodule EbbServer.Sync.Router do
  @moduledoc """
  HTTP router for the EbbServer sync API.

  Provides endpoints:
  - POST /sync/actions — Write actions to the system
  - GET /entities/:id — Read an entity by ID
  - POST /entities/query — Query entities by type
  - POST /sync/handshake — Initialize connection and get group membership
  - GET /sync/live — SSE stream for live updates
  - GET /sync/groups/:group_id — Catch-up for a group
  - POST /sync/presence — Broadcast ephemeral presence data

  Returns appropriate HTTP status codes for various error conditions.
  """

  use Plug.Router

  alias EbbServer.Storage.{
    EntityStore,
    GroupCache,
    PermissionChecker,
    RelationshipCache,
    WatermarkTracker,
    Writer
  }

  alias EbbServer.Sync.{CatchUp, FanOutRouter, SSEHandler}
  alias EbbServer.Sync.Router.OperationSchema

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
        cursors = if is_map(payload["cursors"]), do: payload["cursors"], else: %{}
        _schema_version = payload["schema_version"]

        groups = GroupCache.get_actor_groups(actor_id)
        watermark = WatermarkTracker.committed_watermark()

        response = %{
          "actor_id" => actor_id,
          "groups" =>
            Enum.map(groups, fn %{group_id: gid, permissions: perms} ->
              client_cursor = Map.get(cursors, gid, 0)

              if client_cursor <= watermark do
                %{
                  "id" => gid,
                  "permissions" => perms,
                  "cursor_valid" => true,
                  "reason" => nil,
                  "cursor" => client_cursor
                }
              else
                %{
                  "id" => gid,
                  "permissions" => perms,
                  "cursor_valid" => false,
                  "reason" => "behind_watermark",
                  "cursor" => watermark
                }
              end
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

  post "/sync/presence" do
    {:ok, body, conn} = Plug.Conn.read_body(conn)
    actor_id = conn.assigns.actor_id

    case Jason.decode(body) do
      {:ok, %{"entity_id" => entity_id, "data" => data}}
      when is_binary(entity_id) and entity_id != "" ->
        case RelationshipCache.get_entity_group(entity_id) do
          nil ->
            send_json(conn, 404, %{"error" => "entity_not_found"})

          group_id ->
            if GroupCache.get_permissions(actor_id, group_id) do
              FanOutRouter.broadcast_presence(entity_id, actor_id, data)
              send_resp(conn, 204, "")
            else
              send_json(conn, 403, %{"error" => "not_member"})
            end
        end

      {:ok, _} ->
        send_json(conn, 422, %{
          "error" => "validation_failed",
          "details" => "entity_id is required and must be a non-empty string"
        })

      {:error, _} ->
        send_json(conn, 422, %{"error" => "invalid_json"})
    end
  end

  match _ do
    send_resp(conn, 404, "")
  end

  def openapi_operation(:write_actions) do
    %{
      operationId: "writeActions",
      summary: "Write actions to the system",
      description:
        "Accepts a batch of actions for validation, authorization, and persistence. Actions are processed atomically.",
      tags: ["Sync"],
      requestBody: %{
        required: true,
        content: %{
          "application/msgpack" => %{
            schema: %OpenApiSpex.Schema{
              type: :object,
              required: ["actions"],
              properties: %{
                actions: %OpenApiSpex.Schema{
                  type: :array,
                  items: OperationSchema.action()
                }
              }
            }
          }
        }
      },
      responses: %{
        "200" => OperationSchema.actions_response(),
        "422" =>
          OperationSchema.error_response("Invalid MessagePack or missing/invalid structure"),
        "503" => OperationSchema.error_response("Write operation failed")
      }
    }
  end

  def openapi_operation(:get_entity) do
    %{
      operationId: "getEntity",
      summary: "Read an entity by ID",
      description: "Retrieves a single entity by its ID, materialized from the action log.",
      tags: ["Entities"],
      parameters: [
        OperationSchema.path_param("id", "string", "The entity ID"),
        OperationSchema.query_actor_id_param()
      ],
      responses: %{
        "200" => OperationSchema.entity_response(),
        "400" => OperationSchema.error_response("Missing actor_id"),
        "404" => OperationSchema.error_response("Entity not found"),
        "503" => OperationSchema.error_response("Materialization failed")
      }
    }
  end

  def openapi_operation(:query_entities) do
    %{
      operationId: "queryEntities",
      summary: "Query entities by type",
      description:
        "Returns a list of entities matching the given type, with optional field filtering and pagination.",
      tags: ["Entities"],
      requestBody: %{
        required: true,
        content: %{
          "application/json" => %{
            schema: %OpenApiSpex.Schema{
              type: :object,
              required: ["type"],
              properties: %{
                type: %OpenApiSpex.Schema{type: :string, description: "Entity type to query"},
                filter: %OpenApiSpex.Schema{
                  type: :object,
                  nullable: true,
                  description: "Field-value filter"
                },
                limit: %OpenApiSpex.Schema{
                  type: :integer,
                  nullable: true,
                  description: "Max results to return"
                },
                offset: %OpenApiSpex.Schema{
                  type: :integer,
                  nullable: true,
                  description: "Number of results to skip"
                }
              }
            }
          }
        }
      },
      responses: %{
        "200" => OperationSchema.entities_array_response(),
        "422" => OperationSchema.error_response("Missing or invalid type, or invalid JSON"),
        "503" => OperationSchema.error_response("Query failed")
      }
    }
  end

  def openapi_operation(:handshake) do
    %{
      operationId: "handshake",
      summary: "Initialize connection and get group membership",
      description:
        "Called by clients on connection to obtain their actor ID and group membership information.",
      tags: ["Sync"],
      requestBody: %{
        required: true,
        content: %{
          "application/json" => %{
            schema: %OpenApiSpex.Schema{
              type: :object,
              properties: %{
                cursors: %OpenApiSpex.Schema{
                  type: :object,
                  nullable: true,
                  description: "Map of group_id to cursor GSN",
                  additionalProperties: %OpenApiSpex.Schema{type: :integer, format: :int64}
                },
                schema_version: %OpenApiSpex.Schema{
                  type: :integer,
                  nullable: true,
                  description: "Client schema version"
                }
              }
            }
          }
        }
      },
      responses: %{
        "200" => OperationSchema.handshake_response(),
        "401" => OperationSchema.error_response("Missing actor_id"),
        "422" => OperationSchema.error_response("Invalid JSON body")
      }
    }
  end

  def openapi_operation(:live_updates) do
    %{
      operationId: "liveUpdates",
      summary: "SSE stream for live updates",
      description:
        "Opens a Server-Sent Events stream delivering action events, control events, and presence updates.",
      tags: ["Sync"],
      parameters: [
        OperationSchema.query_param(
          "groups",
          "string",
          "Comma-separated group IDs to subscribe to",
          required: true
        ),
        OperationSchema.query_param("cursor", "string", "GSN cursor to resume from",
          required: false,
          default: "0"
        )
      ],
      responses: %{
        "200" => %{
          description: "SSE stream established",
          content: %{
            "text/event-stream" => %{
              schema: %OpenApiSpex.Schema{type: :string, description: "Raw SSE data payload"}
            }
          }
        },
        "400" => OperationSchema.error_response("Invalid query parameters"),
        "403" => OperationSchema.error_response("Not a member of one or more requested groups")
      }
    }
  end

  def openapi_operation(:catch_up_group) do
    %{
      operationId: "catchUpGroup",
      summary: "Catch-up for a group",
      description: "Returns a paginated list of actions for a group since a given GSN offset.",
      tags: ["Sync"],
      parameters: [
        OperationSchema.path_param("group_id", "string", "The group ID to catch up"),
        OperationSchema.query_param("offset", "string", "GSN offset to start from",
          required: false,
          default: "0"
        )
      ],
      responses: %{
        "200" => %{
          description: "Action list (may be empty)",
          headers: %{
            "stream-next-offset" => %{
              description: "Next GSN offset for pagination. Omitted if no more results.",
              schema: %OpenApiSpex.Schema{type: :string}
            },
            "stream-up-to-date" => %{
              description: "\"true\" if client has caught up to watermark",
              schema: %OpenApiSpex.Schema{type: :string}
            }
          },
          content: %{
            "application/json" => %{
              schema: %OpenApiSpex.Schema{
                type: :array,
                items: OperationSchema.action()
              }
            }
          }
        },
        "400" => OperationSchema.error_response("Invalid offset"),
        "403" => OperationSchema.error_response("Not a member of the group")
      }
    }
  end

  def openapi_operation(:broadcast_presence) do
    %{
      operationId: "broadcastPresence",
      summary: "Broadcast ephemeral presence data",
      description:
        "Broadcasts ephemeral presence data for the authenticated actor on a specific entity.",
      tags: ["Presence"],
      requestBody: %{
        required: true,
        content: %{
          "application/json" => %{
            schema: %OpenApiSpex.Schema{
              type: :object,
              required: ["entity_id", "data"],
              properties: %{
                entity_id: %OpenApiSpex.Schema{
                  type: :string,
                  description: "ID of the entity to broadcast presence for"
                },
                data: %OpenApiSpex.Schema{
                  type: :object,
                  description: "Ephemeral presence data payload"
                }
              }
            }
          }
        }
      },
      responses: %{
        "204" => %OpenApiSpex.Response{
          description: "Presence broadcasted successfully"
        },
        "403" => OperationSchema.error_response("Not a member of the entity's group"),
        "404" => OperationSchema.error_response("Entity not found"),
        "422" => OperationSchema.error_response("Validation failed (missing/invalid entity_id)")
      }
    }
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

defmodule EbbServer.Sync.Router.OperationSchema do
  @moduledoc "Shared schema definitions for OpenAPI operations"

  def action do
    %OpenApiSpex.Schema{
      type: :object,
      required: ["id", "actor_id", "hlc", "updates"],
      properties: %{
        id: %OpenApiSpex.Schema{type: :string, description: "Unique action ID"},
        actor_id: %OpenApiSpex.Schema{type: :string, description: "Actor who created the action"},
        hlc: %OpenApiSpex.Schema{
          type: :integer,
          format: :int64,
          description: "Hybrid Logical Clock timestamp"
        },
        updates: %OpenApiSpex.Schema{
          type: :array,
          items: update()
        }
      }
    }
  end

  def update do
    %OpenApiSpex.Schema{
      type: :object,
      required: ["id", "subject_id", "subject_type", "method"],
      properties: %{
        id: %OpenApiSpex.Schema{type: :string, description: "Unique update ID within the action"},
        subject_id: %OpenApiSpex.Schema{
          type: :string,
          description: "ID of the entity being updated"
        },
        subject_type: %OpenApiSpex.Schema{type: :string, description: "Type of the entity"},
        method: %OpenApiSpex.Schema{
          type: :string,
          enum: ["put", "patch", "delete"],
          description: "Update method"
        },
        data: %OpenApiSpex.Schema{type: :object, nullable: true, description: "Update payload"}
      }
    }
  end

  def entity do
    %OpenApiSpex.Schema{
      type: :object,
      required: ["id", "type", "data", "created_hlc", "updated_hlc", "last_gsn"],
      properties: %{
        id: %OpenApiSpex.Schema{type: :string},
        type: %OpenApiSpex.Schema{type: :string},
        data: %OpenApiSpex.Schema{
          type: :object,
          description: "Contains `fields` map of FieldValue entries"
        },
        created_hlc: %OpenApiSpex.Schema{type: :integer, format: :int64},
        updated_hlc: %OpenApiSpex.Schema{type: :integer, format: :int64},
        deleted_hlc: %OpenApiSpex.Schema{type: :integer, format: :int64, nullable: true},
        last_gsn: %OpenApiSpex.Schema{type: :integer, format: :int64}
      }
    }
  end

  def error do
    %OpenApiSpex.Schema{
      type: :object,
      required: ["error"],
      properties: %{
        error: %OpenApiSpex.Schema{type: :string, description: "Error code string"},
        details: %OpenApiSpex.Schema{
          type: :string,
          nullable: true,
          description: "Human-readable error details"
        }
      }
    }
  end

  def actions_response do
    %OpenApiSpex.Response{
      description: "Actions processed (some may be rejected)",
      content: %{
        "application/json" => %{
          schema: %OpenApiSpex.Schema{
            type: :object,
            properties: %{
              rejected: %OpenApiSpex.Schema{
                type: :array,
                items: rejection()
              }
            }
          }
        }
      }
    }
  end

  def entity_response do
    %OpenApiSpex.Response{
      description: "Entity found",
      content: %{
        "application/json" => %{
          schema: entity()
        }
      }
    }
  end

  def entities_array_response do
    %OpenApiSpex.Response{
      description: "Matching entities",
      content: %{
        "application/json" => %{
          schema: %OpenApiSpex.Schema{
            type: :array,
            items: entity()
          }
        }
      }
    }
  end

  def handshake_response do
    %OpenApiSpex.Response{
      description: "Handshake successful",
      content: %{
        "application/json" => %{
          schema: %OpenApiSpex.Schema{
            type: :object,
            required: ["actor_id", "groups"],
            properties: %{
              actor_id: %OpenApiSpex.Schema{type: :string},
              groups: %OpenApiSpex.Schema{
                type: :array,
                items: group_info()
              }
            }
          }
        }
      }
    }
  end

  def group_info do
    %OpenApiSpex.Schema{
      type: :object,
      required: ["id", "permissions", "cursor_valid", "cursor"],
      properties: %{
        id: %OpenApiSpex.Schema{type: :string, description: "Group ID"},
        permissions: %OpenApiSpex.Schema{type: :array, items: %OpenApiSpex.Schema{type: :string}},
        cursor_valid: %OpenApiSpex.Schema{type: :boolean},
        reason: %OpenApiSpex.Schema{type: :string, nullable: true},
        cursor: %OpenApiSpex.Schema{type: :integer, format: :int64}
      }
    }
  end

  def rejection do
    %OpenApiSpex.Schema{
      type: :object,
      required: ["id", "reason"],
      properties: %{
        id: %OpenApiSpex.Schema{type: :string, description: "ID of the rejected action"},
        reason: %OpenApiSpex.Schema{type: :string, description: "Rejection reason code"},
        details: %OpenApiSpex.Schema{type: :string, nullable: true}
      }
    }
  end

  def error_response(description) do
    %OpenApiSpex.Response{
      description: description,
      content: %{
        "application/json" => %{
          schema: error()
        }
      }
    }
  end

  def path_param(name, type, description) do
    %OpenApiSpex.Parameter{
      name: name,
      in: :path,
      required: true,
      description: description,
      schema: %OpenApiSpex.Schema{type: type}
    }
  end

  def query_param(name, type, description, opts) do
    required = Keyword.get(opts, :required, false)
    default = Keyword.get(opts, :default)
    schema = %OpenApiSpex.Schema{type: type}
    schema = if default, do: Map.put(schema, :default, default), else: schema

    %OpenApiSpex.Parameter{
      name: name,
      in: :query,
      required: required,
      description: description,
      schema: schema
    }
  end

  def query_actor_id_param do
    %OpenApiSpex.Parameter{
      name: :actor_id,
      in: :query,
      required: false,
      description: "Actor ID override. Usually provided via x-ebb-actor-id header.",
      schema: %OpenApiSpex.Schema{type: :string}
    }
  end
end
