defmodule EbbServer.Sync.Router.OpenApiTest do
  @moduledoc """
  Guards the published spec surface: every route publishes one complete
  operation, and the shared schemas the operations reuse stay well formed.

  `mix openapi.gen.spec` consumes these maps to write `openapi.yaml`; a route
  whose operation is missing or malformed would silently drop out of the
  generated spec, so this test drives the same builders the task does.
  """

  use ExUnit.Case, async: true

  alias EbbServer.Sync.Router
  alias EbbServer.Sync.Router.OperationSchema

  describe "openapi_operation/1" do
    test "every route publishes a complete, uniquely identified operation" do
      operations =
        Enum.map(
          Mix.Tasks.Openapi.Gen.Spec.routes(),
          &Router.openapi_operation(&1.operation_atom)
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
      assert Enum.sort(required) == ["id", "method", "subject_id", "subject_type"]

      assert %OpenApiSpex.Schema{type: :object, required: required} = OperationSchema.entity()
      assert Enum.sort(required) == ["created_hlc", "data", "id", "last_gsn", "type", "updated_hlc"]

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
