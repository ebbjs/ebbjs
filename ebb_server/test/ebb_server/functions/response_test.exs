defmodule EbbServer.Functions.ResponseTest do
  use ExUnit.Case, async: true

  alias EbbServer.Functions.Response

  @invocation_id "inv_abc123"
  @version "1.0.0"
  @headers [
    {"x-ebb-invocation-id", @invocation_id},
    {"x-ebb-function-version", @version}
  ]

  describe "success/2" do
    test "builds the success body and headers" do
      assert {200, body, headers} =
               Response.success(%{"proofread" => true},
                 invocation_id: @invocation_id,
                 version: @version
               )

      assert body == %{
               "ok" => true,
               "result" => %{"proofread" => true},
               "invocation_id" => @invocation_id,
               "version" => @version
             }

      assert headers == @headers
    end

    test "keeps a nil result as JSON null" do
      assert {200, body, _headers} =
               Response.success(nil, invocation_id: @invocation_id, version: @version)

      assert Map.fetch!(body, "result") == nil
    end

    test "carries no error vocabulary" do
      {200, body, _headers} =
        Response.success(%{}, invocation_id: @invocation_id, version: @version)

      refute Map.has_key?(body, "error")
      refute Map.has_key?(body, "message")
      refute Map.has_key?(body, "details")
      refute Map.has_key?(body, "retryable")
    end
  end

  describe "failure/2" do
    test "builds an error body and the same headers as success" do
      assert {403, body, headers} =
               Response.failure(403, invocation_id: @invocation_id, version: @version)

      assert body == %{
               "error" => "denied",
               "invocation_id" => @invocation_id,
               "version" => @version
             }

      assert headers == @headers
    end

    test "details are included when present" do
      {422, body, _headers} =
        Response.failure(422,
          invocation_id: @invocation_id,
          version: @version,
          details: "not_authorized: actor is not a group member"
        )

      assert body["details"] == "not_authorized: actor is not a group member"
    end

    test "details are omitted when absent, nil, or empty" do
      for opts <- [
            [invocation_id: @invocation_id, version: @version],
            [invocation_id: @invocation_id, version: @version, details: nil],
            [invocation_id: @invocation_id, version: @version, details: ""]
          ] do
        {500, body, _headers} = Response.failure(500, opts)
        refute Map.has_key?(body, "details")
      end
    end

    test "carries no message key" do
      {500, body, _headers} =
        Response.failure(500, invocation_id: @invocation_id, version: @version, details: "boom")

      refute Map.has_key?(body, "message")
    end

    test "retryable is true only on 408, 429, and 503" do
      for status <- [400, 401, 403, 404, 413, 422, 500] do
        {^status, body, _headers} =
          Response.failure(status, invocation_id: @invocation_id, version: @version)

        refute Map.has_key?(body, "retryable"), "expected #{status} not to be retryable"
      end

      for status <- [408, 429, 503] do
        {^status, body, _headers} =
          Response.failure(status, invocation_id: @invocation_id, version: @version)

        assert body["retryable"] == true
      end
    end

    test "an unknown function carries a null version and no version header" do
      assert {404, body, headers} = Response.failure(404, invocation_id: @invocation_id)

      assert body["version"] == nil
      assert headers == [{"x-ebb-invocation-id", @invocation_id}]
    end
  end

  describe "code_for_status/1" do
    test "maps every status this slice can produce" do
      assert %{
               400 => "invalid_input",
               401 => "unauthorized",
               403 => "denied",
               404 => "not_found",
               408 => "timeout",
               413 => "payload_too_large",
               422 => "rejected",
               429 => "overloaded",
               500 => "internal_error",
               503 => "unavailable"
             } ==
               Map.new(
                 [400, 401, 403, 404, 408, 413, 422, 429, 500, 503],
                 &{&1, Response.code_for_status(&1)}
               )
    end

    test "falls back to a platform error for an unmapped status" do
      assert Response.code_for_status(418) == "internal_error"
    end
  end

  describe "JSON encoding" do
    test "success bodies encode" do
      {200, body, _headers} =
        Response.success(%{"nested" => [1, "two", nil]},
          invocation_id: @invocation_id,
          version: @version
        )

      assert {:ok, json} = Jason.encode(body)
      assert Jason.decode!(json) == body
    end

    test "error bodies encode" do
      {503, body, _headers} =
        Response.failure(503,
          invocation_id: @invocation_id,
          version: @version,
          details: "worker unavailable"
        )

      assert {:ok, json} = Jason.encode(body)
      assert Jason.decode!(json) == body
    end
  end
end
