defmodule EbbServer.Functions.Router.OperationSchema do
  @moduledoc """
  Wire schemas for the `/functions` operations.

  The invocation envelope is `EbbServer.Functions.Response`'s: success is
  `{ok, result, invocation_id, version, replayed?}`, failure is
  `{error, invocation_id, version, details?, issues?, rejected?, retryable?}`.
  The admin routes answer a plain envelope instead — `{ok, ...}` or
  `{error, details?}` with no `invocation_id` — because they are not
  invocations. Both live here so the published spec and the routers cannot
  describe different bodies.

  `rejected` reuses `EbbServer.Sync.Router.OperationSchema.rejection/0`: a
  function's rejected commit and a client's rejected batch are the same list,
  and two schema definitions of it would be free to drift.
  """

  alias EbbServer.Sync.Router.OperationSchema, as: SyncSchema

  @access_values ["granted", "authenticated"]

  def function_summary do
    %OpenApiSpex.Schema{
      type: :object,
      required: ["name", "version", "access"],
      properties: %{
        name: %OpenApiSpex.Schema{type: :string, description: "Function name"},
        version: %OpenApiSpex.Schema{type: :string, description: "Active version"},
        access: %OpenApiSpex.Schema{
          type: :string,
          enum: @access_values,
          description:
            "`granted` needs a `function.<name>` or `function.*` permission; " <>
              "`authenticated` admits any resolved actor"
        },
        paramsSchema: %OpenApiSpex.Schema{
          type: :object,
          nullable: true,
          description: "Stored draft-7 params JSON Schema; omitted when the bundle declared none"
        },
        outputSchema: %OpenApiSpex.Schema{
          type: :object,
          nullable: true,
          description: "Stored draft-7 output JSON Schema; omitted when the bundle declared none"
        }
      }
    }
  end

  def function_list do
    %OpenApiSpex.Schema{
      type: :object,
      required: ["functions"],
      properties: %{
        functions: %OpenApiSpex.Schema{type: :array, items: function_summary()}
      }
    }
  end

  def upload_request do
    %OpenApiSpex.Schema{
      type: :object,
      required: ["envelope", "code"],
      properties: %{
        envelope: %OpenApiSpex.Schema{
          type: :object,
          description:
            "The bundle's declaration: name, version, digest, runtime, contract, access, " <>
              "timeoutMs, memoryBytes, entry, and optional paramsSchema/outputSchema"
        },
        code: %OpenApiSpex.Schema{
          type: :string,
          description: "The bundled ESM source the digest is computed over"
        },
        pinned: %OpenApiSpex.Schema{
          type: :boolean,
          nullable: true,
          description: "Keep this version past retention (default false)"
        }
      }
    }
  end

  def activate_request do
    %OpenApiSpex.Schema{
      type: :object,
      required: ["version"],
      properties: %{
        version: %OpenApiSpex.Schema{
          type: :string,
          description: "The uploaded version to make active"
        }
      }
    }
  end

  def function_version do
    %OpenApiSpex.Schema{
      type: :object,
      required: ["ok", "name", "version", "status"],
      properties: %{
        ok: %OpenApiSpex.Schema{type: :boolean, enum: [true]},
        name: %OpenApiSpex.Schema{type: :string},
        version: %OpenApiSpex.Schema{type: :string},
        status: %OpenApiSpex.Schema{
          type: :string,
          enum: ["active", "retired", "disabled"],
          description: "The row's status after the write"
        },
        pinned: %OpenApiSpex.Schema{
          type: :boolean,
          nullable: true,
          description: "Present on upload; whether retention will keep this version"
        }
      }
    }
  end

  @doc """
  The invocation request body: the function's params.

  The shape is the function's own params schema, so this documents the
  envelope around it rather than guessing fields. An absent body is `{}`.
  """
  def invoke_request do
    %OpenApiSpex.Schema{
      type: :object,
      description:
        "The function's params object, validated against its stored params schema before " <>
          "a worker runs. An empty body is `{}`.",
      additionalProperties: true
    }
  end

  def invocation_success do
    %OpenApiSpex.Schema{
      type: :object,
      required: ["ok", "result", "invocation_id", "version"],
      properties: %{
        ok: %OpenApiSpex.Schema{type: :boolean, enum: [true]},
        result: %OpenApiSpex.Schema{description: "The handler's return value"},
        invocation_id: %OpenApiSpex.Schema{type: :string},
        version: %OpenApiSpex.Schema{type: :string},
        replayed: %OpenApiSpex.Schema{
          type: :boolean,
          nullable: true,
          description:
            "Present only when the invocation committed; true means the Action was already " <>
              "durable or in flight, so no GSN was assigned to this caller"
        }
      }
    }
  end

  def invocation_failure do
    %OpenApiSpex.Schema{
      type: :object,
      required: ["error", "invocation_id"],
      properties: %{
        error: %OpenApiSpex.Schema{type: :string, description: "Error code string"},
        details: %OpenApiSpex.Schema{
          type: :string,
          nullable: true,
          description: "Human-readable reason, never a stack"
        },
        invocation_id: %OpenApiSpex.Schema{type: :string},
        version: %OpenApiSpex.Schema{
          type: :string,
          nullable: true,
          description: "The version that answered; absent when no active version was resolved"
        },
        issues: %OpenApiSpex.Schema{
          type: :array,
          items: issue(),
          description: "Present on `invalid_input` and `invalid_output`"
        },
        rejected: %OpenApiSpex.Schema{
          type: :array,
          items: SyncSchema.rejection(),
          description: "Present when a commit was rejected"
        },
        retryable: %OpenApiSpex.Schema{
          type: :boolean,
          nullable: true,
          description: "True on 408, 429 and 503"
        }
      }
    }
  end

  def issue do
    %OpenApiSpex.Schema{
      type: :object,
      required: ["path", "message"],
      properties: %{
        path: %OpenApiSpex.Schema{
          type: :string,
          description: "Dotted path into the value, e.g. `items[0].name`"
        },
        message: %OpenApiSpex.Schema{type: :string}
      }
    }
  end

  def function_list_response do
    json_response("The active version of every deployed function", function_list())
  end

  def function_version_response(description) do
    json_response(description, function_version())
  end

  def invocation_success_response do
    %OpenApiSpex.Response{
      description: "The function returned successfully",
      headers: invocation_headers(),
      content: %{"application/json" => %{schema: invocation_success()}}
    }
  end

  def invocation_failure_response(description) do
    %OpenApiSpex.Response{
      description: description,
      headers: invocation_headers(),
      content: %{"application/json" => %{schema: invocation_failure()}}
    }
  end

  def error_response(description) do
    json_response(description, error())
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
          description: "Human-readable reason, never a stack"
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

  def idempotency_key_param do
    %OpenApiSpex.Parameter{
      name: "Idempotency-Key",
      in: :header,
      required: false,
      description:
        "Caller-chosen retry key, scoped to the actor and function. A retry with the same " <>
          "key reuses the invocation id, so the commit is deduped and answered as a replay. " <>
          "At most 255 bytes and never repeated.",
      schema: %OpenApiSpex.Schema{type: :string}
    }
  end

  @doc """
  The admin deploy credential.

  No global security scheme is configured, so the credential is documented as
  a required header on each admin route. It is a deploy credential only: it
  never grants invoke permission.
  """
  def admin_auth_param do
    %OpenApiSpex.Parameter{
      name: "Authorization",
      in: :header,
      required: true,
      description:
        "`Bearer <admin token>` — the node's separate deploy credential. Missing, wrong, " <>
          "or unconfigured answers `403 denied`. It does not grant invoke permission.",
      schema: %OpenApiSpex.Schema{type: :string}
    }
  end

  defp invocation_headers do
    %{
      "x-ebb-invocation-id" => %{
        description: "The invocation id, also present in the body",
        schema: %OpenApiSpex.Schema{type: :string}
      },
      "x-ebb-function-version" => %{
        description: "The version that answered; absent when none was resolved",
        schema: %OpenApiSpex.Schema{type: :string}
      }
    }
  end

  defp json_response(description, schema) do
    %OpenApiSpex.Response{
      description: description,
      content: %{"application/json" => %{schema: schema}}
    }
  end
end
