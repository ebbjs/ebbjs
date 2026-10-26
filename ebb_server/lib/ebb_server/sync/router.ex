defmodule EbbServer.Sync.Router do
  @moduledoc """
  HTTP router for the sync API. The full endpoint table is documented
  in `EbbServer`'s top-level README (`@ebb_server/README.md` after #109
  lands in PR 6).

  ## What this module is

  A `Plug.Router` with nine endpoints and one catch-all 404:

    - `GET /healthz` — unauthenticated readiness probe backed by
      `EbbServer.Health`; `200` once the storage layer answers, `503`
      while it is still coming up.
    - `POST /sync/handshake` — returns actor identity, group memberships,
      per-group cursors. Requires `x-ebb-actor-id` header (bypass mode).
    - `GET /sync/groups/:group_id?offset=N` — paginated catch-up for one group.
    - `GET /sync/groups/:group_id/entities?cursor=&limit=` — cold-bootstrap
      listing of the group's state at a watermark (see
      `EbbServer.Sync.GroupListing`).
    - `GET /sync/live?groups=...&cursor=N` — SSE stream of live actions.
    - `POST /sync/actions` — submit a batch of Actions for write.
    - `POST /sync/presence` — broadcast ephemeral presence data on an entity.
    - `GET /entities/:id` — fetch a materialized entity (permission-checked;
      a non-member gets `404`, same as a missing entity).
    - `POST /entities/query` — query entities by type with `json_extract`
      filter and permission JOINs (used by `ctx.query()`).

  ## Status codes

  All errors use the appropriate HTTP status code (`400` for malformed
  body, `401` for auth failures, `403` for permission denied,
  `404` for unknown entity, `409` for HLC drift, `500`/`502`/`503` for
  server errors and readiness failures). The Action-submission endpoint also returns per-Action
  rejections in a `rejected` array so the client can roll back optimistic
  applies.

  ## What this module is not

  This is **request plumbing**; the actual business logic lives in:

  - `EbbServer.Sync.AuthPlug` — actor identity extraction
  - `EbbServer.Storage.PermissionChecker` — per-update auth
  - `EbbServer.Storage.Writer` — write serialization
  - `EbbServer.Storage.EntityStore` — reads with on-demand materialization
  - `EbbServer.Storage.EntityView` — the authorized read and its wire view
  - `EbbServer.Storage.ActionSubmission` — the write sequence and its rejection list
  - `EbbServer.Sync.SSEHandler` — the SSE wire format
  - `EbbServer.Sync.CatchUp` — paginated catch-up
  - `EbbServer.Sync.GroupListing` — group-scoped cold-bootstrap listing
  """

  use Plug.Router

  alias EbbServer.Storage.{
    ActionSubmission,
    CacheTables,
    EntityIndex,
    EntityStore,
    EntityView,
    GroupCache,
    PermissionChecker,
    QueryFilter,
    WatermarkTracker
  }

  alias EbbServer.Sync.{CatchUp, FanOutRouter, GroupListing, SSEHandler}
  alias EbbServer.Sync.Router.OperationSchema

  plug(Plug.Logger)

  # Before AuthPlug: a readiness probe must not depend on the auth
  # configuration or on a caller-supplied actor identity.
  plug(:health_check)

  plug(EbbServer.Sync.AuthPlug)
  plug(:match)
  plug(:dispatch)

  defp health_check(%Plug.Conn{method: "GET", path_info: ["healthz"]} = conn, _opts) do
    case EbbServer.Health.status() do
      :ok -> send_json(conn, 200, %{"status" => "ok"})
      {:error, _reason} -> send_json(conn, 503, %{"status" => "unavailable"})
    end
  end

  defp health_check(conn, _opts), do: conn

  post "/sync/actions" do
    {:ok, body, conn} = Plug.Conn.read_body(conn)
    actor_id = conn.assigns.actor_id

    case decode_msgpack(body) do
      {:ok, actions} ->
        case ActionSubmission.submit(actions, actor_id) do
          {:ok, _gsn_range, rejected} ->
            send_json(conn, 200, %{"rejected" => rejected})

          {:error, _reason} ->
            send_json(conn, 503, %{"error" => "write_failed"})
        end

      {:error, error_type, reason} ->
        send_error(conn, error_type, reason)
    end
  end

  get "/entities/:id" do
    entity_id = conn.path_params["id"]

    case conn.assigns[:actor_id] do
      nil ->
        send_json(conn, 401, %{"error" => "unauthorized"})

      actor_id ->
        case EntityView.for_actor(entity_id, actor_id) do
          {:ok, view} ->
            send_json(conn, 200, view)

          # Non-membership maps to the same 404 as a missing entity: a
          # distinct status would turn the endpoint into an existence
          # oracle for ids the actor cannot read.
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
        opts = if is_nil(payload["limit"]), do: opts, else: [{:limit, payload["limit"]} | opts]

        opts =
          if is_nil(payload["offset"]), do: opts, else: [{:offset, payload["offset"]} | opts]

        case EntityStore.query(type, filter, actor_id, opts) do
          {:ok, entities} ->
            response = Enum.map(entities, &EntityView.json/1)

            send_json(conn, 200, response)

          {:error, :invalid_limit} ->
            send_json(conn, 422, %{"error" => "invalid_limit"})

          {:error, :invalid_offset} ->
            send_json(conn, 422, %{"error" => "invalid_offset"})

          {:error, :invalid_filter} ->
            send_json(conn, 422, %{"error" => "invalid_filter"})

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

  # Excluded from `ebb.http.request_latency_ms`; if this path changes,
  # update `EbbServer.Telemetry.HTTP` (@sse_route) to match.
  get "/sync/live" do
    conn = Plug.Conn.fetch_query_params(conn)
    actor_id = conn.assigns.actor_id

    groups_param = conn.query_params["groups"] || ""
    cursor_param = conn.query_params["cursor"] || "0"

    group_ids = String.split(groups_param, ",", trim: true)

    case Integer.parse(cursor_param) do
      {cursor, ""} when cursor >= 0 and group_ids != [] ->
        if PermissionChecker.member_of_all_groups?(group_ids, actor_id) do
          watermark = WatermarkTracker.committed_watermark()

          if cursor > watermark do
            # Cursor is ahead of the watermark. Send a single SSE
            # control event with reconnect instructions, then halt
            # the plug pipeline. The plug pipeline expects every
            # match clause to return a `%Plug.Conn{}`; `{:stop,
            # :normal}` triggers a RuntimeError that drops the
            # connection before the response is flushed.
            conn
            |> SSEHandler.write_stale_cursor_response(watermark + 1)
            |> Plug.Conn.halt()
          else
            case SSEHandler.open_sse(conn, group_ids, cursor, actor_id) do
              # `open_sse` blocks the request process in a receive
              # loop; this branch is only taken if it returns early
              # (today: never). Halt the pipeline rather than
              # returning `{:stop, :normal}` which Plug.Builder
              # rejects.
              :ok -> Plug.Conn.halt(conn)
              {:error, :not_member} -> send_json(conn, 403, %{"error" => "not_member"})
            end
          end
        else
          send_json(conn, 403, %{"error" => "not_member"})
        end

      _ ->
        send_json(conn, 400, %{"error" => "invalid_params"})
    end
  end

  # Defined before `GET /sync/groups/:group_id` so the more specific path is
  # matched first, even though a `:group_id` segment cannot span a `/`.
  get "/sync/groups/:group_id/entities" do
    conn = Plug.Conn.fetch_query_params(conn)
    group_id = conn.path_params["group_id"]
    actor_id = conn.assigns.actor_id

    case parse_limit(conn.query_params["limit"]) do
      {:ok, limit} ->
        opts = [cursor: conn.query_params["cursor"], limit: limit]

        case GroupListing.list(group_id, actor_id, opts) do
          {:ok, page} ->
            send_json(conn, 200, group_listing_json(page))

          {:error, :not_member} ->
            send_json(conn, 403, %{"error" => "not_member"})

          {:error, :bad_cursor} ->
            send_json(conn, 400, %{"error" => "bad_cursor"})

          {:error, :invalid_limit} ->
            send_json(conn, 400, %{"error" => "invalid_limit"})

          {:error, :materialization_failed} ->
            send_json(conn, 503, %{"error" => "materialization_failed"})
        end

      {:error, :invalid_limit} ->
        send_json(conn, 400, %{"error" => "invalid_limit"})
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
        group_ids =
          EntityIndex.source_groups(entity_id, entity_groups: CacheTables.entity_groups())

        member_group_ids = PermissionChecker.member_group_ids(group_ids, actor_id)

        if member_group_ids != [] do
          FanOutRouter.broadcast_presence(member_group_ids, entity_id, actor_id, data)
          send_resp(conn, 204, "")
        else
          # A foreign entity and an unused id share one response: telling them
          # apart would hand callers an existence oracle for entity ids.
          send_json(conn, 404, %{"error" => "entity_not_found"})
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
      description:
        "Retrieves a single entity by its ID, materialized from the action log. " <>
          "Requires the actor to be a member of one of the entity's groups.",
      tags: ["Entities"],
      parameters: [
        OperationSchema.path_param("id", "string", "The entity ID")
      ],
      responses: %{
        "200" => OperationSchema.entity_response(),
        "401" => OperationSchema.error_response("Missing or invalid x-ebb-actor-id header"),
        "404" =>
          OperationSchema.error_response(
            "Entity not found, or the actor is not a member of any of its groups"
          ),
        "503" => OperationSchema.error_response("Materialization failed")
      }
    }
  end

  def openapi_operation(:query_entities) do
    %{
      operationId: "queryEntities",
      summary: "Query entities by type",
      description:
        "Returns a list of entities matching the given type, with optional field filtering and " <>
          "pagination. Results are ordered by creation HLC, then by entity ID, and each entity " <>
          "appears once.",
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
                  maxProperties: QueryFilter.max_keys(),
                  description:
                    "Field-value filter: identifier-shaped keys mapped to JSON scalars " <>
                      "(string, number, boolean or null), at most " <>
                      "#{QueryFilter.max_keys()} keys"
                },
                limit: %OpenApiSpex.Schema{
                  type: :integer,
                  nullable: true,
                  description: "Max results to return (1-1000, default 200)"
                },
                offset: %OpenApiSpex.Schema{
                  type: :integer,
                  nullable: true,
                  description: "Number of results to skip (a non-negative 64-bit integer)"
                }
              }
            }
          }
        }
      },
      responses: %{
        "200" => OperationSchema.entities_array_response(),
        "422" =>
          OperationSchema.error_response(
            "Missing or invalid type, invalid JSON, a filter that is not identifier keys " <>
              "mapped to JSON scalars, or a limit/offset out of range"
          ),
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

  def openapi_operation(:list_group_entities) do
    %{
      operationId: "listGroupEntities",
      summary: "List a group's entities as of a watermark",
      description:
        "Returns one page of the group's state at a resolution frontier: the group row, its " <>
          "live groupMember rows, every live entityGroup row in the group, and the live " <>
          "entities those rows name. Page with `cursor` until `has_more` is false, then tail " <>
          "the group from `watermark`. Entity objects are identical in shape to " <>
          "`GET /entities/{id}`.",
      tags: ["Sync"],
      parameters: [
        OperationSchema.path_param("group_id", "string", "The group ID to list"),
        OperationSchema.query_param(
          "cursor",
          "string",
          "Opaque cursor from the previous page (omit for the first page)",
          required: false
        ),
        OperationSchema.query_param(
          "limit",
          "integer",
          "Maximum membership rows per page (1-1000); each may carry its entity",
          required: false,
          default: 200
        )
      ],
      responses: %{
        "200" => OperationSchema.group_listing_response(),
        "400" => OperationSchema.error_response("Invalid limit or cursor"),
        "403" => OperationSchema.error_response("Not a member of the group"),
        "503" => OperationSchema.error_response("Materialization failed")
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
        "404" =>
          OperationSchema.error_response(
            "Entity not found, or the actor is not a member of any of its groups"
          ),
        "422" => OperationSchema.error_response("Validation failed (missing/invalid entity_id)")
      }
    }
  end

  def openapi_operation(:health) do
    %{
      operationId: "health",
      summary: "Readiness probe",
      description:
        "Reports whether the node can serve sync traffic. Requires no authentication and " <>
          "returns 200 only after the storage layer answers a cheap read.",
      tags: ["Health"],
      responses: %{
        "200" => OperationSchema.health_response("ok", "Storage layer is ready"),
        "503" =>
          OperationSchema.health_response(
            "unavailable",
            "Application or storage layer is not ready; retry after it recovers"
          )
      }
    }
  end

  defp group_listing_json(page) do
    %{
      "group_id" => page.group_id,
      "watermark" => page.watermark,
      "cursor" => page.cursor,
      "has_more" => page.has_more,
      "entities" => Enum.map(page.entities, &EntityView.json/1)
    }
  end

  defp parse_limit(nil), do: {:ok, nil}

  defp parse_limit(value) when is_binary(value) do
    case Integer.parse(value) do
      {limit, ""} when limit > 0 -> {:ok, limit}
      _ -> {:error, :invalid_limit}
    end
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

  def group_listing_response do
    %OpenApiSpex.Response{
      description: "One page of the group's state at the watermark",
      content: %{
        "application/json" => %{
          schema: %OpenApiSpex.Schema{
            type: :object,
            required: ["group_id", "watermark", "cursor", "has_more", "entities"],
            properties: %{
              group_id: %OpenApiSpex.Schema{type: :string},
              watermark: %OpenApiSpex.Schema{
                type: :integer,
                format: :int64,
                description: "Resolution frontier this page is complete as of"
              },
              cursor: %OpenApiSpex.Schema{
                type: :string,
                nullable: true,
                description: "Opaque cursor for the next page; null when has_more is false"
              },
              has_more: %OpenApiSpex.Schema{type: :boolean},
              entities: %OpenApiSpex.Schema{type: :array, items: entity()}
            }
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

  def health_response(status, description) do
    %OpenApiSpex.Response{
      description: description,
      content: %{
        "application/json" => %{
          schema: %OpenApiSpex.Schema{
            type: :object,
            required: ["status"],
            properties: %{
              status: %OpenApiSpex.Schema{type: :string, enum: [status]}
            }
          }
        }
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
end
