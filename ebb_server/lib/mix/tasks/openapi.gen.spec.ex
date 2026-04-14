defmodule Mix.Tasks.Openapi.Gen.Spec do
  @moduledoc """
  Generates an OpenAPI 3.1 spec from router annotations and writes it to openapi.yaml.

  Usage:
      mix openapi.gen.spec

  The spec is written to the project root (openapi.yaml).
  """
  use Mix.Task

  alias EbbServer.Sync.Router
  alias EbbServer.Sync.Router.OperationSchema

  @impl true
  def run(_args) do
    {:ok, _} = Application.ensure_all_started(:open_api_spex)

    paths =
      Enum.reduce(
        routes(),
        %{},
        fn %{method: method, path: path, operation_atom: op_atom}, acc ->
          operation = Router.openapi_operation(op_atom)
          openapi_path = to_openapi_path(path)

          path_item =
            case Map.fetch(acc, openapi_path) do
              {:ok, existing} ->
                Map.merge(existing, %{method => operation})

              :error ->
                %{
                  get: nil,
                  put: nil,
                  post: nil,
                  delete: nil,
                  options: nil,
                  head: nil,
                  patch: nil,
                  trace: nil
                }
                |> Map.put(method, operation)
            end

          Map.put(acc, openapi_path, path_item)
        end
      )

    api_spec = %OpenApiSpex.OpenApi{
      openapi: "3.1.0",
      info: %OpenApiSpex.Info{
        title: "EbbServer Sync API",
        version: "0.1.0",
        description: "A sync server for collaborative applications."
      },
      servers: [
        %OpenApiSpex.Server{url: "http://localhost:4000", description: "Local development server"}
      ],
      paths: paths,
      components: %OpenApiSpex.Components{
        schemas: %{
          "Action" => OperationSchema.action(),
          "Update" => OperationSchema.update(),
          "Entity" => OperationSchema.entity(),
          "Error" => OperationSchema.error(),
          "GroupInfo" => OperationSchema.group_info(),
          "Rejection" => OperationSchema.rejection()
        }
      }
    }

    spec_map = OpenApiSpex.OpenApi.to_map(api_spec)
    spec_content = Jason.encode!(spec_map, pretty: true)

    spec_path =
      Path.join(__DIR__ |> Path.dirname() |> Path.dirname() |> Path.dirname(), "openapi.yaml")

    File.write!(spec_path, spec_content)

    Mix.shell().info("Written OpenAPI spec to #{spec_path}")
  end

  defp routes do
    [
      %{method: :post, path: "/sync/actions", operation_atom: :write_actions},
      %{method: :get, path: "/entities/:id", operation_atom: :get_entity},
      %{method: :post, path: "/entities/query", operation_atom: :query_entities},
      %{method: :post, path: "/sync/handshake", operation_atom: :handshake},
      %{method: :get, path: "/sync/live", operation_atom: :live_updates},
      %{method: :get, path: "/sync/groups/:group_id", operation_atom: :catch_up_group},
      %{method: :post, path: "/sync/presence", operation_atom: :broadcast_presence}
    ]
  end

  defp to_openapi_path(path) do
    path
    |> String.split("/")
    |> Enum.map_join("/", fn
      ":" <> segment -> "{#{segment}}"
      segment -> segment
    end)
  end
end
