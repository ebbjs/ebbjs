defmodule EbbServer.Admin.Router do
  @moduledoc """
  The `/admin/apps` HTTP surface: register, list, and revoke apps and their
  browser origins.

  The registry itself is `EbbServer.Apps`; this module is request plumbing
  only. Registration is operator or CI work — a deployed static app cannot
  hold a credential — so every route authenticates with the node-level admin
  credential (`EbbServer.Admin.Token`) in `Authorization: Bearer <token>`.
  There is no actor and no `x-ebb-actor-id` on this surface.

  `EbbServer.Sync.Router` forwards the `/admin` subtree here before
  `EbbServer.Sync.AuthPlug`, so an admin request is authenticated by the
  admin credential alone. A node with no credential configured answers `403`
  for every route rather than opening them.

    - `GET /apps` — the registered apps.
    - `POST /apps` — `{"name", "origins"}`; the name is unique
      case-insensitively and each origin is unique across apps.
    - `DELETE /apps/:id` — remove an app and every origin it admits.
    - `POST /apps/:id/origins` — `{"origin"}`.
    - `DELETE /apps/:id/origins/:origin` — the origin is URL-encoded in the
      path.

  Origins are normalized by `EbbServer.Apps.Origin`: lowercase scheme and
  host, default port stripped, no path/query/fragment, `null` rejected. A
  wildcard is accepted only as the whole first host label
  (`https://*.example.com`). Registration admits browser origins to CORS; it
  is not authorization and does not affect non-browser clients.
  """

  use Plug.Router

  alias EbbServer.Admin.Router.OperationSchema
  alias EbbServer.Admin.Token
  alias EbbServer.Apps

  plug(:authorize)
  plug(:match)
  plug(:dispatch)

  # The parent router forwards the whole `/admin` subtree, so this router sees
  # `[]`, `/apps`, `/apps/:id`, and so on. Redirecting `/` would only make the
  # admin surface more discoverable; the catch-all answers it like any unknown
  # path.
  get "/apps" do
    send_json(conn, 200, %{"apps" => Enum.map(Apps.list(apps_opts(conn)), &app_json/1)})
  end

  post "/apps" do
    with {:ok, payload, conn} <- read_json(conn),
         {:ok, name, origins} <- app_fields(payload, conn) do
      case Apps.add(name, origins, apps_opts(conn)) do
        {:ok, app} -> send_json(conn, 201, %{"app" => app_json(app)})
        {:error, reason} -> send_app_error(conn, reason)
      end
    else
      {:error, conn} ->
        conn

      {:error, :invalid_request, conn} ->
        send_json(conn, 422, validation("name and origins are required"))
    end
  end

  delete "/apps/:id" do
    id = conn.path_params["id"]

    case Apps.remove(id, apps_opts(conn)) do
      :ok -> conn |> send_resp(204, "") |> Plug.Conn.halt()
      {:error, reason} -> send_app_error(conn, reason)
    end
  end

  post "/apps/:id/origins" do
    id = conn.path_params["id"]

    with {:ok, payload, conn} <- read_json(conn),
         {:ok, origin} <- origin_field(payload, conn) do
      case Apps.add_origin(id, origin, apps_opts(conn)) do
        {:ok, app} -> send_json(conn, 200, %{"app" => app_json(app)})
        {:error, reason} -> send_app_error(conn, reason)
      end
    else
      {:error, conn} -> conn
      {:error, :invalid_request, conn} -> send_json(conn, 422, validation("origin is required"))
    end
  end

  delete "/apps/:id/origins/:origin" do
    id = conn.path_params["id"]
    origin = conn.path_params["origin"] |> URI.decode()

    case Apps.remove_origin(id, origin, apps_opts(conn)) do
      {:ok, app} -> send_json(conn, 200, %{"app" => app_json(app)})
      {:error, reason} -> send_app_error(conn, reason)
    end
  end

  match _ do
    conn |> send_resp(404, "") |> Plug.Conn.halt()
  end

  # ---------------------------------------------------------------------------
  # Auth
  # ---------------------------------------------------------------------------

  # `:admin_opts` is how a suite injects an isolated registry and token; a
  # forwarded request has none and uses the node's resolved credential.
  defp authorize(conn, _opts) do
    case Token.authorize(conn, token: admin_token(conn)) do
      :ok ->
        conn

      {:error, :not_configured} ->
        send_json(conn, 403, %{
          "error" => "admin_not_configured",
          "details" => "This node has no admin credential configured."
        })

      {:error, :denied} ->
        conn
        |> Plug.Conn.put_resp_header("www-authenticate", ~s(Bearer realm="ebb admin"))
        |> send_json(401, %{"error" => "unauthorized"})
    end
  end

  defp admin_token(conn) do
    case Keyword.fetch(admin_opts(conn), :token) do
      {:ok, token} -> token
      :error -> Token.value()
    end
  end

  defp apps_opts(conn), do: Keyword.get(admin_opts(conn), :apps, [])

  defp admin_opts(conn), do: Map.get(conn.assigns, :admin_opts, [])

  # ---------------------------------------------------------------------------
  # Request plumbing
  # ---------------------------------------------------------------------------

  defp app_fields(%{"name" => name, "origins" => origins}, conn)
       when is_binary(name) and is_list(origins) do
    if Enum.all?(origins, &is_binary/1) do
      {:ok, name, origins}
    else
      {:error, :invalid_request, conn}
    end
  end

  defp app_fields(_payload, conn), do: {:error, :invalid_request, conn}

  defp origin_field(%{"origin" => origin}, _conn) when is_binary(origin), do: {:ok, origin}
  defp origin_field(_payload, conn), do: {:error, :invalid_request, conn}

  defp read_json(conn) do
    case Plug.Conn.read_body(conn, length: 64_000) do
      {:ok, body, conn} ->
        case Jason.decode(body) do
          {:ok, payload} when is_map(payload) -> {:ok, payload, conn}
          _malformed -> {:error, send_json(conn, 400, %{"error" => "invalid_json"})}
        end

      {:more, _partial, conn} ->
        {:error, send_json(conn, 413, %{"error" => "payload_too_large"})}

      {:error, _reason, conn} ->
        {:error, send_json(conn, 400, %{"error" => "invalid_body"})}
    end
  end

  defp send_app_error(conn, :duplicate_name) do
    send_json(conn, 409, %{
      "error" => "duplicate_name",
      "details" => "An app with that name exists."
    })
  end

  defp send_app_error(conn, :duplicate_origin) do
    send_json(conn, 409, %{
      "error" => "duplicate_origin",
      "details" => "That origin is already registered."
    })
  end

  defp send_app_error(conn, :invalid_name) do
    send_json(conn, 422, validation("name must be a non-empty string of at most 100 characters"))
  end

  defp send_app_error(conn, :invalid_origin) do
    send_json(
      conn,
      422,
      validation("origin must be an http(s) origin, optionally with a leading *.")
    )
  end

  defp send_app_error(conn, :not_found) do
    send_json(conn, 404, %{"error" => "not_found"})
  end

  defp send_app_error(conn, :origin_not_found) do
    send_json(conn, 404, %{"error" => "origin_not_found"})
  end

  defp send_app_error(conn, :storage_error) do
    send_json(conn, 500, %{"error" => "storage_error"})
  end

  defp validation(details), do: %{"error" => "validation_failed", "details" => details}

  defp app_json(app) do
    %{
      "id" => app.id,
      "name" => app.name,
      "origins" => app.origins,
      "created_at" => app.created_at
    }
  end

  defp send_json(conn, status, body) do
    case Jason.encode(body) do
      {:ok, json} ->
        conn
        |> Plug.Conn.put_resp_content_type("application/json")
        |> Plug.Conn.send_resp(status, json)
        |> Plug.Conn.halt()

      {:error, _} ->
        conn
        |> Plug.Conn.put_resp_content_type("application/json")
        |> Plug.Conn.send_resp(500, ~s({"error":"encoding_failed"}))
        |> Plug.Conn.halt()
    end
  end

  # ---------------------------------------------------------------------------
  # OpenAPI
  # ---------------------------------------------------------------------------

  def openapi_operation(:list_apps) do
    %{
      operationId: "listApps",
      summary: "List registered apps",
      description:
        "Returns every app the operator registered and the browser origins each one admits. " <>
          "Requires the admin credential in `Authorization: Bearer <token>`.",
      tags: ["Admin"],
      parameters: [OperationSchema.admin_auth_param()],
      responses: %{
        "200" => OperationSchema.app_list_response(),
        "401" => OperationSchema.error_response("Missing or wrong admin credential"),
        "403" => OperationSchema.error_response("This node has no admin credential configured")
      }
    }
  end

  def openapi_operation(:create_app) do
    %{
      operationId: "createApp",
      summary: "Register an app and its origins",
      description:
        "Registers one app with at least one browser origin. The name is unique " <>
          "case-insensitively; every origin is unique across apps and normalized before " <>
          "storage. Registration admits browser origins to CORS; it is not authorization.",
      tags: ["Admin"],
      parameters: [OperationSchema.admin_auth_param()],
      requestBody: %{
        required: true,
        content: %{
          "application/json" => %{
            schema: %OpenApiSpex.Schema{
              type: :object,
              required: ["name", "origins"],
              properties: %{
                name: %OpenApiSpex.Schema{type: :string, description: "Operator-facing app name"},
                origins: %OpenApiSpex.Schema{
                  type: :array,
                  items: %OpenApiSpex.Schema{type: :string},
                  description: "Browser origins, e.g. https://app.example.com"
                }
              }
            }
          }
        }
      },
      responses: %{
        "201" => OperationSchema.app_response("The app was registered"),
        "400" => OperationSchema.error_response("Malformed JSON"),
        "401" => OperationSchema.error_response("Missing or wrong admin credential"),
        "403" => OperationSchema.error_response("This node has no admin credential configured"),
        "409" => OperationSchema.error_response("Duplicate app name or origin"),
        "413" => OperationSchema.error_response("Body over 64 KiB"),
        "422" => OperationSchema.error_response("Invalid name or origin"),
        "500" => OperationSchema.error_response("The registry could not be written")
      }
    }
  end

  def openapi_operation(:delete_app) do
    %{
      operationId: "deleteApp",
      summary: "Remove an app and its origins",
      description:
        "Removes the app and every origin it admits. Revocation reaches browsers after " <>
          "the preflight cache (`Access-Control-Max-Age`, about 300 seconds).",
      tags: ["Admin"],
      parameters: [
        OperationSchema.path_param("id", "string", "The app id"),
        OperationSchema.admin_auth_param()
      ],
      responses: %{
        "204" => %OpenApiSpex.Response{description: "The app was removed"},
        "401" => OperationSchema.error_response("Missing or wrong admin credential"),
        "403" => OperationSchema.error_response("This node has no admin credential configured"),
        "404" => OperationSchema.error_response("Unknown app id"),
        "500" => OperationSchema.error_response("The registry could not be written")
      }
    }
  end

  def openapi_operation(:add_app_origin) do
    %{
      operationId: "addAppOrigin",
      summary: "Add one origin to an app",
      description:
        "Adds and normalizes one browser origin. A wildcard is accepted only as the whole " <>
          "first host label (`https://*.example.com`); the same origin may not be registered " <>
          "to two apps.",
      tags: ["Admin"],
      parameters: [
        OperationSchema.path_param("id", "string", "The app id"),
        OperationSchema.admin_auth_param()
      ],
      requestBody: %{
        required: true,
        content: %{
          "application/json" => %{
            schema: %OpenApiSpex.Schema{
              type: :object,
              required: ["origin"],
              properties: %{origin: %OpenApiSpex.Schema{type: :string}}
            }
          }
        }
      },
      responses: %{
        "200" => OperationSchema.app_response("The origin was added"),
        "400" => OperationSchema.error_response("Malformed JSON"),
        "401" => OperationSchema.error_response("Missing or wrong admin credential"),
        "403" => OperationSchema.error_response("This node has no admin credential configured"),
        "404" => OperationSchema.error_response("Unknown app id"),
        "409" => OperationSchema.error_response("That origin is already registered"),
        "413" => OperationSchema.error_response("Body over 64 KiB"),
        "422" => OperationSchema.error_response("Invalid origin"),
        "500" => OperationSchema.error_response("The registry could not be written")
      }
    }
  end

  def openapi_operation(:remove_app_origin) do
    %{
      operationId: "removeAppOrigin",
      summary: "Remove one origin from an app",
      description:
        "Removes one origin, given URL-encoded in the path. The app keeps its other " <>
          "origins. Revocation reaches browsers after the preflight cache.",
      tags: ["Admin"],
      parameters: [
        OperationSchema.path_param("id", "string", "The app id"),
        OperationSchema.path_param("origin", "string", "URL-encoded origin"),
        OperationSchema.admin_auth_param()
      ],
      responses: %{
        "200" => OperationSchema.app_response("The origin was removed"),
        "401" => OperationSchema.error_response("Missing or wrong admin credential"),
        "403" => OperationSchema.error_response("This node has no admin credential configured"),
        "404" => OperationSchema.error_response("Unknown app id or origin"),
        "422" => OperationSchema.error_response("Invalid origin"),
        "500" => OperationSchema.error_response("The registry could not be written")
      }
    }
  end
end

defmodule EbbServer.Admin.Router.OperationSchema do
  @moduledoc "Shared schema definitions for the admin operations."

  def admin_auth_param do
    %OpenApiSpex.Parameter{
      name: "Authorization",
      in: :header,
      required: true,
      description: "`Bearer <admin token>`",
      schema: %OpenApiSpex.Schema{type: :string}
    }
  end

  def app do
    %OpenApiSpex.Schema{
      type: :object,
      required: ["id", "name", "origins", "created_at"],
      properties: %{
        id: %OpenApiSpex.Schema{type: :string},
        name: %OpenApiSpex.Schema{type: :string},
        origins: %OpenApiSpex.Schema{
          type: :array,
          items: %OpenApiSpex.Schema{type: :string}
        },
        created_at: %OpenApiSpex.Schema{type: :string, format: :"date-time"}
      }
    }
  end

  def app_response(description) do
    %OpenApiSpex.Response{
      description: description,
      content: %{
        "application/json" => %{
          schema: %OpenApiSpex.Schema{
            type: :object,
            required: ["app"],
            properties: %{app: app()}
          }
        }
      }
    }
  end

  def app_list_response do
    %OpenApiSpex.Response{
      description: "Registered apps",
      content: %{
        "application/json" => %{
          schema: %OpenApiSpex.Schema{
            type: :object,
            required: ["apps"],
            properties: %{
              apps: %OpenApiSpex.Schema{type: :array, items: app()}
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
          schema: %OpenApiSpex.Schema{
            type: :object,
            required: ["error"],
            properties: %{
              error: %OpenApiSpex.Schema{type: :string},
              details: %OpenApiSpex.Schema{type: :string, nullable: true}
            }
          }
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
end
