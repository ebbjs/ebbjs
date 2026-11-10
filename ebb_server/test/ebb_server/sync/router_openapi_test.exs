defmodule EbbServer.Sync.Router.OpenApiTest do
  @moduledoc """
  Guards the published spec surface: every route publishes one complete
  operation, and the shared schemas the operations reuse stay well formed.

  `mix openapi.gen.spec` consumes these maps to write `openapi.yaml`; a route
  whose operation is missing or malformed would silently drop out of the
  generated spec, so this test drives the same builders the task does.
  """

  use ExUnit.Case, async: true

  alias EbbServer.Functions.Router, as: FunctionsRouter
  alias EbbServer.Sync.Router
  alias EbbServer.Sync.Router.OperationSchema

  describe "openapi_operation/1" do
    test "every route publishes a complete, uniquely identified operation" do
      operations =
        Enum.map(
          Mix.Tasks.Openapi.Gen.Spec.routes(),
          & &1.module.openapi_operation(&1.operation_atom)
        )

      for operation <- operations do
        assert is_binary(operation.operationId) and operation.operationId != ""
        assert is_binary(operation.summary) and operation.summary != ""
        assert is_binary(operation.description) and operation.description != ""
        assert is_list(operation.tags) and operation.tags != []

        assert map_size(operation.responses) > 0

        for {status, response} <- operation.responses do
          assert is_binary(status)
          assert is_map(response)
          assert is_binary(response.description) and response.description != ""
          if response.content != nil, do: assert(map_size(response.content) > 0)
        end
      end

      ids = Enum.map(operations, & &1.operationId)
      assert length(Enum.uniq(ids)) == length(ids)
    end

    test "every route names the module that owns its operation" do
      modules = Mix.Tasks.Openapi.Gen.Spec.routes() |> Enum.map(& &1.module) |> Enum.uniq()

      assert Enum.sort(modules) == [
               EbbServer.Admin.Router,
               EbbServer.Functions.Router,
               EbbServer.Sync.Router
             ]
    end

    test "the functions routes publish their wire shapes" do
      routes = Mix.Tasks.Openapi.Gen.Spec.routes()

      for operation_atom <- [
            :upload_function_version,
            :activate_function,
            :invoke_function
          ] do
        route = Enum.find(routes, &(&1.operation_atom == operation_atom))
        assert route.module == FunctionsRouter

        operation = route.module.openapi_operation(operation_atom)
        assert is_map(operation.requestBody)
        assert Map.has_key?(operation.requestBody.content, "application/json")
        assert is_list(operation.parameters) and operation.parameters != []
      end

      list = FunctionsRouter.openapi_operation(:list_functions)
      refute Map.has_key?(list, :requestBody)

      for admin_atom <- [:upload_function_version, :activate_function] do
        operation = FunctionsRouter.openapi_operation(admin_atom)

        assert Enum.any?(operation.parameters, fn param ->
                 param.name == "Authorization" and param.in == :header and param.required
               end)
      end
    end

    test "the functions operations are reachable at their published paths" do
      paths = Mix.Tasks.Openapi.Gen.Spec.routes() |> Enum.map(& &1.path) |> Enum.uniq()

      assert "/functions" in paths
      assert "/functions/:name" in paths
      assert "/functions/:name/versions" in paths
      assert "/functions/:name/activate" in paths
    end

    test "broadcastPresence publishes its volume rejections" do
      operation = Router.openapi_operation(:broadcast_presence)

      assert %{description: payload_description} = operation.responses["413"]
      assert payload_description =~ "payload"

      assert %{description: rate_description} = operation.responses["429"]
      assert rate_description =~ "Retry-After"
    end

    test "write operations publish a request body and reads publish parameters" do
      write = Router.openapi_operation(:write_actions)
      assert is_map(write.requestBody)
      assert Map.has_key?(write.requestBody.content, "application/msgpack")

      handshake = Router.openapi_operation(:handshake)
      assert Map.has_key?(handshake.requestBody.content, "application/json")

      for operation <- [
            Router.openapi_operation(:get_entity),
            Router.openapi_operation(:live_updates),
            Router.openapi_operation(:list_group_entities),
            Router.openapi_operation(:catch_up_group)
          ] do
        assert is_list(operation.parameters) and operation.parameters != []

        for param <- operation.parameters do
          assert is_binary(param.name)
          assert is_binary(param.description) and param.description != ""
          assert %OpenApiSpex.Schema{} = param.schema
        end
      end
    end
  end

  describe "OperationSchema" do
    test "the shared entity schemas carry their documented required fields" do
      assert %OpenApiSpex.Schema{type: :object, required: required} = OperationSchema.action()
      assert Enum.sort(required) == ["actor_id", "hlc", "id", "updates"]

      assert %OpenApiSpex.Schema{type: :object, required: required} = OperationSchema.update()
      assert Enum.sort(required) == ["id", "method", "subject_id"]

      assert %OpenApiSpex.Schema{type: :object, required: required} = OperationSchema.entity()

      assert Enum.sort(required) == [
               "created_hlc",
               "data",
               "id",
               "last_gsn",
               "type",
               "updated_hlc"
             ]

      assert %OpenApiSpex.Schema{type: :object, required: ["error"]} = OperationSchema.error()

      for schema <- [OperationSchema.group_info(), OperationSchema.rejection()] do
        assert %OpenApiSpex.Schema{type: :object, required: [_ | _], properties: properties} =
                 schema

        assert map_size(properties) > 0
      end
    end

    test "the shared responses are renderable and reference an entity schema" do
      for response <- [
            OperationSchema.actions_response(),
            OperationSchema.entity_response(),
            OperationSchema.entities_array_response(),
            OperationSchema.group_listing_response(),
            OperationSchema.handshake_response()
          ] do
        assert %OpenApiSpex.Response{description: description} = response
        assert is_binary(description) and description != ""
        assert %{"application/json" => %{schema: %OpenApiSpex.Schema{}}} = response.content
      end

      for response <- [
            OperationSchema.error_response("boom"),
            OperationSchema.health_response("ok", "Storage layer is ready")
          ] do
        assert %OpenApiSpex.Response{} = response
        assert response.content != nil
      end
    end

    test "parameters are non-nullable primitives with a description" do
      for param <- [
            OperationSchema.path_param("id", "string", "The entity ID"),
            OperationSchema.query_param("limit", "integer", "Page size", [])
          ] do
        assert %OpenApiSpex.Parameter{name: name, description: description} = param
        assert is_binary(name)
        assert is_binary(description) and description != ""
        assert %OpenApiSpex.Schema{} = param.schema
      end
    end
  end
end
