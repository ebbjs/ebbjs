defmodule EbbServer.Functions.Router do
  @moduledoc """
  The `/functions` HTTP surface: invoke, list, upload, activate, rollback, and
  disable.

  The routes are mounted by `EbbServer.Sync.Router`, which forwards every
  `/functions` subtree here only while `EbbServer.Functions.enabled?/0` is true.
  When it is false the parent router never calls this module, so the paths fall
  through to its ordinary catch-all: absent, not "disabled". See
  `EbbServer.Functions` for why the flag is resolved once at boot.

    - `GET /` — the deployed names, their active version, permission posture,
      and RPC schemas. No code. Any resolved actor may call it; it is
      authenticated, not admin-only, because a caller needs to see the shape of
      what it is allowed to invoke.
    - `POST /:name` — invoke one function; JSON params in, JSON result out.
    - `POST /:name/versions` — upload a bundle for `:name`.
    - `GET /:name/versions` — the name's version history (status, timestamps,
      pin, creator, deployment hash; never code). Admin, because it includes
      retired and disabled versions an operator uses to roll back or re-enable.
    - `POST /:name/activate` — point `:name` at one of its uploaded versions.
    - `POST /:name/rollback` — activate the version that was active when the
      current one was last activated, walking back through the chain
      (v3 → v2 → v1), never a disabled version.
    - `POST /:name/disable` — the operator kill switch: the name's active version
      becomes `disabled`, the name resolves `404`, and activating it again
      re-enables it.
    - `GET /health` — admin-only per-version counters and pool gauges.

  Upload, activation, rollback, disable, and version history are admin
  operations and require the separate deploy credential
  (`EbbServer.Functions.Admin`). Invocation is an ordinary permission, checked
  by `EbbServer.Functions.Access` against the actor's grants; holding the admin
  token never grants it.

  `AuthPlug` runs before the routes, so a request without an identity is
  refused by that shared plug with its usual `401 unauthorized` body. Every
  route below repeats that `401` for a caller that reached this router
  directly, since a direct call has no parent plug in front of it.

  ## One invocation id, always

  Invocation requests mint an `invocation_id` before anything is looked up, so
  every invocation response — success, unknown function, denied, malformed
  body, timeout — carries one in the body and in `x-ebb-invocation-id`. By
  default it is `"inv_" <> nanoid(16)` over the same `[0-9a-z]` alphabet as
  `generateId("inv")`, so it belongs to the one id space the storage layer
  indexes.

  The list, upload, activate, rollback, disable, and history routes are not
  invocations, so their bodies use a plain envelope — `{"ok": true, ...}` or
  `{"error": code, "details"?}` — with no `invocation_id`. Only invocation
  responses go through `EbbServer.Functions.Response`.

  ## Idempotency-Key

  An invocation request may carry one `Idempotency-Key` header. With it, the
  invocation id is derived from the key instead of minted:
  `"inv_" <> first16(lowercase_hex(sha256(actor_id <> "\\n" <> name <> "\\n" <> key)))`,
  still 16 characters of the same alphabet. `EbbServer.Functions.Host` derives
  the Action id from the invocation id, so a retry of the same request
  reproduces the same `action_id`; `cf_action_dedup` drops the second copy
  before it claims a GSN, and the response carries `"replayed": true`.

  The key is scoped to the actor and the function, because it is a value the
  caller chooses: two callers that happen to pick the same string are not
  retrying the same request, and must not share a dedup key. A service
  principal (M5) acts as one subject actor, so every caller behind one
  credential shares this key space; those callers must use their own keys.
  Within that scope a repeated key silently drops whatever content the retry
  carries, including a retry whose handler produced different writes. The first commit under that
  `action_id` is the durable one and every later one is answered as a replay.
  Only send the header when the request is safe to repeat unchanged; a key is
  not a way to perform a second, different write. One invocation commits at
  most one Action, so this also holds within a single request.

  An empty key, a key longer than 255 bytes, or the header repeated is a `400`
  rather than a derived id: requests that disagree about what was meant must
  not end up sharing a dedup key. Such a response still carries a freshly
  minted invocation id, because the body names the invocation that refused.

  ## Order of work for an invocation

  1. Read the body within a size limit.
  2. Resolve the active bundle through `EbbServer.Functions.BundleCache`.
  3. Authorize with `EbbServer.Functions.Access` — before any worker is
     spawned, so a denied request costs nothing.
  4. Validate the params against the bundle's stored params schema
     (`EbbServer.Functions.Validate`) — also before any worker is checked out,
     so a request that cannot run costs nothing either.
  5. Build the `invoke` frame and hand it to
     `EbbServer.Functions.Invocation.run/1`.

  The result is then checked against the bundle's optional output schema. A
  result that fails it is `422 invalid_output`, and the invocation's writes
  stay committed: the commit happened inside the handler, and the output schema
  describes the reply, not the transaction. The runner revalidates with the
  full Standard Schema; this side is the cheap gate at the trust boundary.

  A tampered or broken bundle is a `500`, never a `404`: a digest mismatch is
  not a typo in the URL, and answering `not_found` for a bundle that exists but
  fails verification would hide a bad deploy.

  ## Size limits

  An invocation body is read with `EbbServer.Functions.max_invoke_body_bytes/0`
  — 256 KiB by default — in 64 KiB chunks, so an oversize body is refused
  without being buffered whole and before a worker is checked out. The body is
  deliberately smaller than the 1 MiB frame bound: it becomes the `input` field
  of the `invoke` frame, which also carries the bundle's code, and an input that
  cannot fit alongside that code is a request to refuse rather than one to
  buffer. The assembled frame is measured before it is sent, and either case
  answers `413 payload_too_large`.

  Upload bodies carry code, which the frame bound does not describe, so they
  are read with their own limit: #{8 * 1024 * 1024} bytes, again in 64 KiB
  chunks. An activation body is one short version string and rides the same
  reader.

  ## Upload and activation

  An upload is `{"envelope": {...}, "code": "...", "pinned": false}` plus an
  optional `deploymentHash`. The envelope is the bundle's own declaration —
  name, version, digest, runtime, contract, access, limits, entry, and the
  optional schemas — and `EbbServer.Functions.Bundle.new/2` verifies the digest,
  contract, name, grammar, and every schema before the row exists.
  `deploymentHash` is opaque to this server: the CLI computes it over the code
  digest and the behaviour-bearing envelope fields, uploads it, and reads it
  back from the history to skip a deploy that changes nothing. The route checks
  only its shape (`sha256:` and 64 lowercase hex characters) and stores it; an
  absent or `null` value is a row from an older CLI, and anything else present
  that does not match the shape is `400 invalid_bundle`. A re-upload of an
  existing
  `(name, version)` is `409` and never replaces stored code. Uploading does not
  activate; the reply says which version was stored and that it is `retired`
  until somebody activates it.

  Activation is `{"version": "<version>"}` and is one store transaction:
  whatever was active is retired, the target becomes active, and the target's
  schemas are re-resolved first, so a row tampered with after upload cannot
  become active. Rollback is the store's operation, not a route of its own in
  this issue.

  ## Options

  Router options exist so tests can avoid the registered processes and the
  application's ETS tables. They are read from the assign
  `copy_opts_to_assign` gives them, because `Plug.Router` compiles function
  plugs with their options at build time:

    * `:cache` — the `EbbServer.Functions.BundleCache` to ask (default
      `EbbServer.Functions.BundleCache`)
    * `:store` — the `EbbServer.Functions.Store` to read and write (default
      `EbbServer.Functions.Store`)
    * `:admin_token` — the deploy credential to compare against (default
      `EbbServer.Functions.admin_token/0`)
    * `:group_members_table` — the ETS table holding grants (default
      `EbbServer.Storage.CacheTables.group_members/0`)

  Everything else (the worker transport, its options, and the bundle
  directory) comes from `EbbServer.Functions` config, because it describes the
  node rather than the request.
  """

  use Plug.Router, copy_opts_to_assign: :functions_opts

  alias EbbServer.Actor
  alias EbbServer.Functions

  alias EbbServer.Functions.{
    Access,
    Admin,
    Bundle,
    BundleCache,
    Invocation,
    Principal,
    Protocol,
    Response
  }

  alias EbbServer.Functions.Router.OperationSchema
  alias EbbServer.Functions.{Stats, Store, Validate}
  alias EbbServer.Functions.Store.Version
  alias EbbServer.Functions.Worker.Pool
  alias EbbServer.Storage.CacheTables

  # An upload carries code plus its envelope, which the frame bound does not
  # describe.
  @max_upload_bytes 8 * 1024 * 1024
  @read_chunk_bytes 64 * 1024
  @idempotency_key_header "idempotency-key"
  @max_idempotency_key_bytes 255
  # The CLI's deployment hash has the same shape as a bundle digest. This server
  # never recomputes it: it is the CLI's bookkeeping, so the route only checks
  # that what the history will echo back is a well-formed one.
  @deployment_hash_pattern ~r/\Asha256:[0-9a-f]{64}\z/
  @admin_denied_details "an admin credential is required to deploy or activate"

  plug(:match)
  plug(:dispatch)

  get "/" do
    with_principal(conn, &list_functions/2)
  end

  get "/health" do
    health(conn)
  end

  post "/:name/versions" do
    upload_version(conn, conn.path_params["name"])
  end

  get "/:name/versions" do
    list_function_versions(conn, conn.path_params["name"])
  end

  post "/:name/activate" do
    activate_version(conn, conn.path_params["name"])
  end

  post "/:name/rollback" do
    rollback_version(conn, conn.path_params["name"])
  end

  post "/:name/disable" do
    disable_function(conn, conn.path_params["name"])
  end

  post "/:name" do
    name = conn.path_params["name"]

    case Principal.resolve(conn, principal_opts(conn)) do
      {:ok, principal} ->
        with_idempotency_key(conn, name, principal)

      {:error, :unauthenticated} ->
        respond(conn, Response.failure(401, invocation_id: new_invocation_id()))

      {:error, :denied} ->
        respond(
          conn,
          Response.failure(403,
            invocation_id: new_invocation_id(),
            details: "the service token is not recognized"
          )
        )
    end
  end

  # `Plug.Router` requires a catch-all. The parent only forwards `/functions`,
  # so this answers a wrong method exactly as the parent's own catch-all would.
  match _ do
    conn |> Plug.Conn.send_resp(404, "") |> Plug.Conn.halt()
  end

  # ---------------------------------------------------------------------------
  # Route plumbing
  # ---------------------------------------------------------------------------

  defp cache(conn) do
    Keyword.get(conn.assigns.functions_opts, :cache, BundleCache)
  end

  defp store(conn) do
    Keyword.get(conn.assigns.functions_opts, :store, Store)
  end

  defp admin_token(conn) do
    Keyword.get(conn.assigns.functions_opts, :admin_token, Functions.admin_token())
  end

  defp group_members_table(conn) do
    Keyword.get(
      conn.assigns.functions_opts,
      :group_members_table,
      CacheTables.group_members()
    )
  end

  # The parent's `AuthPlug` answers this first in production; the branch is for
  # a direct call and says the same thing in the plain envelope.
  defp with_actor(conn, fun) do
    case conn.assigns[:actor] do
      %Actor{id: actor_id} when is_binary(actor_id) and actor_id != "" -> fun.(conn, actor_id)
      _missing -> send_json(conn, 401, %{"error" => "unauthorized"})
    end
  end

  defp principal_opts(conn) do
    case Keyword.fetch(conn.assigns.functions_opts, :services) do
      {:ok, services} -> [services: services]
      :error -> []
    end
  end

  # Invocation and the catalogue accept either principal kind; a service has no
  # actor assign, so the actor-only `with_actor/2` would deny it.
  defp with_principal(conn, fun) do
    case Principal.resolve(conn, principal_opts(conn)) do
      {:ok, principal} ->
        fun.(conn, principal)

      {:error, :unauthenticated} ->
        send_json(conn, 401, %{"error" => "unauthorized"})

      {:error, :denied} ->
        send_json(conn, 403, %{"error" => "denied", "details" => "unrecognized service token"})
    end
  end

  defp with_idempotency_key(conn, name, principal) do
    case idempotency_key(conn) do
      {:ok, key} ->
        invoke(conn, name, principal, invocation_id_for(principal, name, key))

      {:error, details} ->
        respond(conn, invalid_key_response(details))
    end
  end

  defp admin_authorized?(conn) do
    Admin.authorize(conn, admin_token: admin_token(conn)) == :ok
  end

  # A plain `{ok|error}` body with no invocation envelope or headers, used by
  # the catalogue and deploy routes. `EbbServer.Sync.Router` names the same
  # helper the same way.
  defp send_json(conn, status, body), do: respond(conn, {status, body, []})

  defp internal_error(conn) do
    send_json(conn, 500, %{"error" => "internal_error", "details" => store_unavailable()})
  end

  defp store_unavailable, do: "the functions store is unavailable"

  # Every body and header is built as `{status, body, headers}`; this is the
  # only place that writes them to the conn.
  defp respond(conn, {status, body, headers} = response) do
    case Jason.encode(body) do
      {:ok, json} -> send_body(conn, status, json, headers)
      {:error, _reason} -> respond(conn, unencodable(response))
    end
  end

  defp unencodable({_status, %{"invocation_id" => invocation_id} = body, _headers}) do
    Response.failure(500,
      invocation_id: invocation_id,
      version: body["version"],
      details: "response could not be encoded"
    )
  end

  defp unencodable(_response) do
    {500, %{"error" => "internal_error", "details" => "response could not be encoded"}, []}
  end

  defp send_body(conn, status, json, headers) do
    conn
    |> Plug.Conn.put_resp_content_type("application/json")
    |> put_headers(headers)
    |> Plug.Conn.send_resp(status, json)
    |> Plug.Conn.halt()
  end

  defp put_headers(conn, headers) do
    Enum.reduce(headers, conn, fn {name, value}, conn ->
      Plug.Conn.put_resp_header(conn, name, value)
    end)
  end

  # ---------------------------------------------------------------------------
  # GET / — list
  # ---------------------------------------------------------------------------

  # Authenticated, not admin-only: a caller needs the names, versions, and
  # schemas of what it may invoke, and none of that is code. The admin
  # credential is what lets a caller publish, never what lets it read the
  # catalogue.
  defp list_functions(conn, _principal) do
    case list_versions(conn) do
      {:ok, versions} ->
        send_json(conn, 200, %{"functions" => Enum.map(versions, &function_summary/1)})

      {:error, _reason} ->
        internal_error(conn)
    end
  end

  defp list_versions(conn) do
    with_store(fn -> Store.list(store(conn)) end)
  end

  # --- GET /health ---------------------------------------------------------

  # Admin-only: the counters name every version the node has served, including
  # retired and disabled ones, and an operator is the reader. The pool gauges
  # are the same numbers the telemetry event carries.
  defp health(conn) do
    if admin_authorized?(conn) do
      # Health answers even when the store is unavailable: the counters and
      # pool gauges are exactly what an operator needs to diagnose that.
      {storage, versions} =
        case list_versions(conn) do
          {:ok, versions} -> {"ok", versions}
          {:error, _reason} -> {"unavailable", []}
        end

      snapshot = Stats.snapshot()

      send_json(conn, 200, %{
        "ok" => true,
        "storage" => storage,
        "functions" => merge_health(versions, snapshot["functions"]),
        "pool" => snapshot["pool"]
      })
    else
      send_json(conn, 403, %{
        "error" => "denied",
        "details" => @admin_denied_details
      })
    end
  end

  # The store's active versions are the rows an operator expects to see even
  # before anything invoked them; the counters fill in whatever has run.
  defp merge_health(versions, counters) do
    counted = Map.new(counters, fn row -> {{row["name"], row["version"]}, row} end)

    active =
      Enum.map(versions, fn %Version{} = version ->
        counted
        |> Map.get({version.name, version.version}, %{})
        |> Map.merge(%{
          "name" => version.name,
          "version" => version.version,
          "access" => version.access
        })
        |> zero_counters()
      end)

    active_names = MapSet.new(active, &{&1["name"], &1["version"]})

    retired =
      counters
      |> Enum.reject(&MapSet.member?(active_names, {&1["name"], &1["version"]}))
      |> Enum.map(&zero_counters/1)

    active ++ retired
  end

  defp zero_counters(row) do
    Map.merge(
      %{
        "invocations" => 0,
        "errors" => 0,
        "timeouts" => 0,
        "worker_kills" => 0,
        "fetch_calls" => 0
      },
      row
    )
  end

  defp function_summary(%Version{} = version) do
    %{
      "name" => version.name,
      "version" => version.version,
      "access" => version.access
    }
    |> put_schema("paramsSchema", version.params_schema)
    |> put_schema("outputSchema", version.output_schema)
  end

  defp put_schema(summary, _key, nil), do: summary
  defp put_schema(summary, key, schema), do: Map.put(summary, key, schema)

  # ---------------------------------------------------------------------------
  # POST /:name/versions — upload
  # ---------------------------------------------------------------------------

  # The credential is checked before the body is read: an unauthorized caller
  # should not be able to make the server buffer eight megabytes first.
  defp upload_version(conn, name) do
    with_actor(conn, fn conn, actor_id ->
      if admin_authorized?(conn) do
        read_and_upload(conn, name, actor_id)
      else
        admin_denied(conn)
      end
    end)
  end

  defp read_and_upload(conn, name, actor_id) do
    case read_upload(conn) do
      {:ok, payload, conn} -> put_version(conn, name, actor_id, payload)
      {:error, response, conn} -> respond(conn, response)
    end
  end

  defp admin_denied(conn) do
    send_json(conn, 403, %{"error" => "denied", "details" => @admin_denied_details})
  end

  defp put_version(conn, name, actor_id, payload) do
    with {:ok, envelope, code, pinned, deployment_hash} <- upload_payload(payload, name),
         {:ok, bundle} <- Bundle.new(envelope, code) do
      record_version(conn, bundle, pinned, actor_id, deployment_hash)
    else
      {:error, reason} ->
        send_json(conn, 400, %{
          "error" => "invalid_bundle",
          "details" => invalid_bundle_details(reason)
        })
    end
  end

  defp invalid_schema(conn, field, reason) do
    send_json(conn, 422, %{
      "error" => "invalid_schema",
      "details" => "#{field} is not a valid JSON Schema: #{reason}"
    })
  end

  defp record_version(conn, %Bundle{} = bundle, pinned, actor_id, deployment_hash) do
    case store_put_version(conn, version_attrs(bundle, pinned, actor_id, deployment_hash)) do
      {:ok, %Version{} = version} ->
        send_json(conn, 201, %{
          "ok" => true,
          "name" => version.name,
          "version" => version.version,
          "status" => version.status,
          "pinned" => version.pinned
        })

      {:error, :already_exists} ->
        send_json(conn, 409, %{
          "error" => "already_exists",
          "details" => duplicate_details(bundle)
        })

      {:error, {:invalid_schema, field, reason}} ->
        invalid_schema(conn, field, reason)

      {:error, _reason} ->
        internal_error(conn)
    end
  end

  defp store_put_version(conn, attrs) do
    with_store(fn -> Store.put_version(attrs, store(conn)) end)
  end

  # The store is another process: a node being torn down makes it exit, which
  # is a read/write failure, never an empty catalogue or a successful write.
  defp with_store(fun) do
    fun.()
  catch
    :exit, reason -> {:error, {:store_unavailable, reason}}
  end

  defp version_attrs(%Bundle{} = bundle, pinned, actor_id, deployment_hash) do
    %{
      name: bundle.name,
      version: bundle.version,
      code: bundle.code,
      digest: bundle.digest,
      runtime: bundle.runtime,
      contract: bundle.contract,
      access: bundle.access,
      timeout_ms: bundle.timeout_ms,
      memory_bytes: bundle.memory_bytes,
      entry: bundle.entry,
      params_schema: bundle.params_schema,
      output_schema: bundle.output_schema,
      created_by: actor_id,
      pinned: pinned,
      deployment_hash: deployment_hash
    }
  end

  defp duplicate_details(%Bundle{} = bundle) do
    "version #{bundle.version} of #{bundle.name} already exists; " <>
      "upload a new version instead of replacing code"
  end

  # The shape checks the route owns; everything about the bundle itself is
  # `Bundle.new/2`'s, so the two cannot disagree.
  defp upload_payload(payload, name) do
    envelope = payload["envelope"]
    code = payload["code"]
    pinned = Map.get(payload, "pinned", false)
    deployment_hash = Map.get(payload, "deploymentHash")

    cond do
      not is_map(envelope) ->
        {:error, :envelope_not_object}

      not (is_binary(code) and code != "") ->
        {:error, :code_not_string}

      envelope["name"] != name ->
        {:error, :name_mismatch}

      not is_boolean(pinned) ->
        {:error, :pinned_not_boolean}

      not valid_deployment_hash?(deployment_hash) ->
        {:error, :invalid_deployment_hash}

      true ->
        {:ok, envelope, code, pinned, deployment_hash}
    end
  end

  # Absent is an older CLI, not an error; anything present has to be the shape
  # the CLI publishes, because the history echoes it back verbatim.
  defp valid_deployment_hash?(nil), do: true

  defp valid_deployment_hash?(hash) when is_binary(hash),
    do: Regex.match?(@deployment_hash_pattern, hash)

  defp valid_deployment_hash?(_hash), do: false

  # Every reason is a sentence for the uploader, never a stack or an internal
  # term. The status already says which class of refusal it is.
  defp invalid_bundle_details(:envelope_not_object), do: "envelope must be a JSON object"

  defp invalid_bundle_details(:code_not_string),
    do: "code must be a non-empty string"

  defp invalid_bundle_details(:name_mismatch),
    do: "envelope name does not match the name in the path"

  defp invalid_bundle_details(:pinned_not_boolean),
    do: "pinned must be a boolean"

  defp invalid_bundle_details(:invalid_deployment_hash),
    do: "deploymentHash must be `sha256:` followed by 64 lowercase hex characters"

  defp invalid_bundle_details({:missing_field, field}),
    do: "envelope is missing #{field}"

  defp invalid_bundle_details({:invalid_field, field}),
    do: "envelope field #{field} is invalid"

  defp invalid_bundle_details({:invalid_name, _name}),
    do: "envelope name is not a valid function name"

  defp invalid_bundle_details(:digest_mismatch),
    do: "bundle digest does not match its code"

  defp invalid_bundle_details({:unsupported_contract, contract}),
    do: "bundle contract #{contract} is not supported by this server"

  defp invalid_bundle_details({:invalid_schema, field, _reason}),
    do: "envelope #{field} is not a valid JSON Schema"

  defp invalid_bundle_details(_reason), do: "the bundle is invalid"

  defp read_upload(conn) do
    case read_limited_body(conn, @max_upload_bytes) do
      {:ok, body, conn} -> decode_upload(body, conn)
      {:error, response, conn} -> {:error, response, conn}
    end
  end

  defp decode_upload("", conn) do
    {:error, {400, %{"error" => "invalid_json", "details" => "request body is required"}, []},
     conn}
  end

  defp decode_upload(body, conn) do
    case Jason.decode(body) do
      {:ok, %{} = payload} ->
        {:ok, payload, conn}

      {:ok, _other} ->
        {:error,
         {400,
          %{
            "error" => "invalid_json",
            "details" => "request body must be a JSON object"
          }, []}, conn}

      {:error, _reason} ->
        {:error,
         {400, %{"error" => "invalid_json", "details" => "request body is not valid JSON"}, []},
         conn}
    end
  end

  # ---------------------------------------------------------------------------
  # POST /:name/activate — activation
  # ---------------------------------------------------------------------------

  defp activate_version(conn, name) do
    with_actor(conn, fn conn, _actor_id ->
      if admin_authorized?(conn) do
        read_and_activate(conn, name)
      else
        admin_denied(conn)
      end
    end)
  end

  defp read_and_activate(conn, name) do
    case read_activation(conn) do
      {:ok, version, conn} -> activate(conn, name, version)
      {:error, response, conn} -> respond(conn, response)
    end
  end

  defp activate(conn, name, version) do
    case store_activate(conn, name, version) do
      {:ok, %Version{} = activated} ->
        send_json(conn, 200, %{
          "ok" => true,
          "name" => activated.name,
          "version" => activated.version,
          "status" => activated.status
        })

      {:error, :not_found} ->
        send_json(conn, 404, %{
          "error" => "not_found",
          "details" => "no version #{version} of #{name} was uploaded"
        })

      {:error, {:invalid_schema, field, reason}} ->
        invalid_schema(conn, field, reason)

      {:error, _reason} ->
        internal_error(conn)
    end
  end

  defp store_activate(conn, name, version) do
    with_store(fn -> Store.activate(name, version, store(conn)) end)
  end

  defp read_activation(conn) do
    case read_limited_body(conn, @max_upload_bytes) do
      {:ok, body, conn} -> decode_activation(body, conn)
      {:error, response, conn} -> {:error, response, conn}
    end
  end

  defp decode_activation(body, conn) do
    case decode_object(body) do
      {:ok, %{"version" => version}} when is_binary(version) and version != "" ->
        {:ok, version, conn}

      {:ok, _payload} ->
        {:error,
         {400,
          %{
            "error" => "invalid_input",
            "details" => "version must be a non-empty string"
          }, []}, conn}

      {:error, details} ->
        {:error, {400, %{"error" => "invalid_json", "details" => details}, []}, conn}
    end
  end

  defp decode_object(body) do
    case Jason.decode(body) do
      {:ok, %{} = payload} -> {:ok, payload}
      {:ok, _other} -> {:error, "request body must be a JSON object"}
      {:error, _reason} -> {:error, "request body is not valid JSON"}
    end
  end

  # ---------------------------------------------------------------------------
  # Version history, rollback, and disable
  # ---------------------------------------------------------------------------

  defp list_function_versions(conn, name) do
    with_actor(conn, fn conn, _actor_id ->
      if admin_authorized?(conn) do
        history(conn, name)
      else
        admin_denied(conn)
      end
    end)
  end

  # An unknown name and a name with no rows are the same answer: the history
  # endpoint names a function that does not exist. A disabled name still has
  # rows, so it remains visible and can be re-activated.
  defp history(conn, name) do
    case with_store(fn -> Store.versions(name, store(conn)) end) do
      {:ok, []} ->
        send_json(conn, 404, %{
          "error" => "not_found",
          "details" => "no versions of #{name} were uploaded"
        })

      {:ok, versions} ->
        send_json(conn, 200, %{"versions" => Enum.map(versions, &version_info/1)})

      {:error, _reason} ->
        internal_error(conn)
    end
  end

  # The history says what an operator needs to choose a version and what a CLI
  # needs to print or to skip a no-op deploy; code stays out of it. The
  # deployment hash is present only on rows that carried one, so a row from an
  # older CLI does not report a value it never had.
  defp version_info(%Version{} = version) do
    %{
      "version" => version.version,
      "status" => version.status,
      "createdAt" => version.created_at,
      "activatedAt" => version.activated_at,
      "pinned" => version.pinned,
      "createdBy" => version.created_by
    }
    |> put_deployment_hash(version.deployment_hash)
  end

  defp put_deployment_hash(info, nil), do: info

  defp put_deployment_hash(info, hash),
    do: Map.put(info, "deploymentHash", hash)

  defp rollback_version(conn, name) do
    with_actor(conn, fn conn, _actor_id ->
      if admin_authorized?(conn) do
        rollback(conn, name)
      else
        admin_denied(conn)
      end
    end)
  end

  defp rollback(conn, name) do
    case with_store(fn -> Store.rollback(name, store(conn)) end) do
      {:ok, %Version{} = active} ->
        send_json(conn, 200, %{
          "ok" => true,
          "name" => active.name,
          "version" => active.version,
          "status" => active.status
        })

      {:error, :not_found} ->
        send_json(conn, 404, %{
          "error" => "not_found",
          "details" => "#{name} has no active version to roll back from"
        })

      {:error, :no_previous_version} ->
        send_json(conn, 409, %{
          "error" => "no_previous_version",
          "details" => "#{name} has no earlier activation to roll back to"
        })

      {:error, {:invalid_schema, field, reason}} ->
        invalid_schema(conn, field, reason)

      {:error, _reason} ->
        internal_error(conn)
    end
  end

  defp disable_function(conn, name) do
    with_actor(conn, fn conn, _actor_id ->
      if admin_authorized?(conn) do
        disable(conn, name)
      else
        admin_denied(conn)
      end
    end)
  end

  defp disable(conn, name) do
    case with_store(fn -> Store.disable(name, store(conn)) end) do
      {:ok, %Version{} = disabled} ->
        send_json(conn, 200, %{
          "ok" => true,
          "name" => disabled.name,
          "version" => disabled.version,
          "status" => disabled.status
        })

      {:error, :not_found} ->
        send_json(conn, 404, %{
          "error" => "not_found",
          "details" => "#{name} has no active version to disable"
        })

      {:error, _reason} ->
        internal_error(conn)
    end
  end

  # ---------------------------------------------------------------------------
  # POST /:name — invoke
  # ---------------------------------------------------------------------------

  defp new_invocation_id do
    "inv_" <> Nanoid.generate(16, "abcdefghijklmnopqrstuvwxyz0123456789")
  end

  # A header can only make the id stable, never choose it: the derived id is
  # still `inv_` plus 16 characters of the id alphabet, so the storage layer's
  # dedup keys stay in one space.
  defp idempotency_key(conn) do
    case Plug.Conn.get_req_header(conn, @idempotency_key_header) do
      [] -> {:ok, nil}
      [key] -> validate_key(key)
      _repeated -> {:error, "Idempotency-Key must not be repeated"}
    end
  end

  defp validate_key("") do
    {:error, "Idempotency-Key must not be empty"}
  end

  defp validate_key(key) when byte_size(key) > @max_idempotency_key_bytes do
    {:error, "Idempotency-Key must be at most #{@max_idempotency_key_bytes} bytes"}
  end

  defp validate_key(key), do: {:ok, key}

  defp invocation_id_for(_principal, _name, nil), do: new_invocation_id()
  defp invocation_id_for(principal, name, key), do: derived_invocation_id(principal, name, key)

  # The principal and function scope the key: it is caller-chosen, so two
  # callers that pick the same string are not retrying the same request. For a
  # service credential the principal is the credential, so two credentials
  # sharing a subject actor still get distinct Actions. Callers behind one
  # credential share this key space and must use their own keys.
  defp derived_invocation_id(%{id: principal_id}, name, key) do
    digest =
      :crypto.hash(:sha256, [principal_id, "\n", name, "\n", key])
      |> Base.encode16(case: :lower)

    "inv_" <> binary_part(digest, 0, 16)
  end

  defp invalid_key_response(details) do
    Response.failure(400,
      invocation_id: new_invocation_id(),
      code: "invalid_idempotency_key",
      details: details
    )
  end

  defp invoke(conn, name, principal, invocation_id) do
    case active_bundle(conn, name, invocation_id) do
      {:ok, bundle} ->
        authorize(conn, bundle, principal, invocation_id)

      {:error, response} ->
        respond(conn, response)
    end
  end

  # An empty body is no parameters; a JSON body must be an object because the
  # frame's `input` is the function's argument map.
  defp read_input(conn) do
    case read_limited_body(conn, Functions.max_invoke_body_bytes()) do
      {:ok, "", conn} ->
        {:ok, %{}, conn}

      {:ok, body, conn} ->
        decode_input(body, conn)

      {:error, {status, %{"details" => details}, _headers}, conn} ->
        {:error, status, details, conn}
    end
  end

  defp read_limited_body(conn, max_bytes) do
    case Plug.Conn.read_body(conn, length: max_bytes, read_length: @read_chunk_bytes) do
      {:ok, body, conn} ->
        {:ok, body, conn}

      {:more, _partial, conn} ->
        {:error,
         {413,
          %{
            "error" => "payload_too_large",
            "details" => "request body exceeds #{max_bytes} bytes"
          }, []}, conn}

      {:error, _reason} ->
        {:error,
         {400, %{"error" => "invalid_json", "details" => "request body could not be read"}, []},
         conn}
    end
  end

  defp decode_input(body, conn) do
    case Jason.decode(body) do
      {:ok, %{} = input} -> {:ok, input, conn}
      {:ok, _other} -> {:error, 400, "request body must be a JSON object", conn}
      {:error, _reason} -> {:error, 400, "request body is not valid JSON", conn}
    end
  end

  # A cache that is not running while the flag says enabled is a broken boot,
  # not a client error; answer in the envelope rather than raising out of the
  # request process.
  defp active_bundle(conn, name, invocation_id) do
    case BundleCache.active(name, cache(conn)) do
      {:ok, bundle} ->
        {:ok, bundle}

      {:error, :unknown_function} ->
        {:error, Response.failure(404, invocation_id: invocation_id)}

      {:error, reason} ->
        {:error,
         Response.failure(500, invocation_id: invocation_id, details: lookup_details(reason))}
    end
  catch
    :exit, _reason ->
      {:error,
       Response.failure(500,
         invocation_id: invocation_id,
         details: "bundle cache is unavailable"
       )}
  end

  # A caller that may not invoke this function never reaches the transport, so
  # a denied request spawns nothing. Authorization also precedes the body read:
  # a denied caller should not be able to make the server read a megabyte first.
  defp authorize(conn, bundle, principal, invocation_id) do
    table = group_members_table(conn)

    case Access.authorize(bundle.access, principal, bundle.name, table: table) do
      :ok ->
        with_secrets(conn, bundle, principal, invocation_id)

      {:error, :denied} ->
        respond(
          conn,
          Response.failure(403, invocation_id: invocation_id, version: bundle.version)
        )
    end
  end

  # A configured secret with no value fails before the body is read and before
  # a worker exists. The response names the missing keys, never a value.
  defp with_secrets(conn, bundle, principal, invocation_id) do
    case Functions.invocation_env(bundle.name) do
      {:ok, env} ->
        read_and_execute(conn, bundle, principal, invocation_id, env)

      {:error, {:missing_secret, keys}} ->
        respond(
          conn,
          Response.failure(422,
            invocation_id: invocation_id,
            version: bundle.version,
            code: "missing_secret",
            details: "missing secret: #{Enum.join(keys, ", ")}"
          )
        )
    end
  end

  defp read_and_execute(conn, bundle, principal, invocation_id, env) do
    case read_input(conn) do
      {:ok, input, conn} ->
        respond(conn, execute(bundle, principal, invocation_id, input, env))

      {:error, status, details, conn} ->
        respond(
          conn,
          Response.failure(status,
            invocation_id: invocation_id,
            version: bundle.version,
            details: details
          )
        )
    end
  end

  # Params are validated before the frame exists, so a request whose input
  # cannot satisfy the schema never reaches a worker.
  defp execute(bundle, principal, invocation_id, input, env) do
    case Validate.params(bundle, input) do
      :ok -> frame_and_run(bundle, principal, invocation_id, input, env)
      {:error, issues} -> invalid_input(bundle, invocation_id, issues)
    end
  end

  defp frame_and_run(bundle, principal, invocation_id, input, env) do
    frame = invoke_frame(bundle, principal, invocation_id, input, env)

    if Protocol.fits?(frame) do
      bundle
      |> run_invocation(frame, principal, input)
      |> to_response(invocation_id, bundle)
    else
      Response.failure(413,
        invocation_id: invocation_id,
        version: bundle.version,
        details: "invoke frame exceeds #{Protocol.max_frame_bytes()} bytes"
      )
    end
  end

  defp invalid_input(bundle, invocation_id, issues) do
    Response.failure(400,
      invocation_id: invocation_id,
      version: bundle.version,
      code: "invalid_input",
      issues: issues
    )
  end

  defp invoke_frame(bundle, principal, invocation_id, input, env) do
    Protocol.invoke(%{
      "invocation_id" => invocation_id,
      "name" => bundle.name,
      "version" => bundle.version,
      "digest" => bundle.digest,
      "bundle" => bundle.code,
      "entry" => bundle.entry,
      "input" => input,
      "subject_actor_id" => principal.actor_id,
      "caller_kind" => Atom.to_string(principal.kind),
      "env" => env,
      "limits" => Map.put(Functions.limits(), "timeout_ms", bundle.timeout_ms)
    })
  end

  defp run_invocation(bundle, frame, principal, input) do
    opts = [
      invoke: frame,
      deadline_ms: bundle.timeout_ms,
      max_host_calls: Functions.max_host_calls(),
      max_log_lines: Functions.max_log_lines(),
      max_log_bytes: Functions.max_log_bytes(),
      input_bytes: input_bytes(input),
      telemetry_meta: %{
        name: bundle.name,
        version: bundle.version,
        actor_id: principal.actor_id,
        caller_kind: principal.kind
      }
    ]

    if pooled?() do
      Invocation.run(opts ++ [transport: Pool.Transport, worker_opts: [pool: Pool]])
    else
      Invocation.run(
        opts ++ [transport: Functions.transport(), worker_opts: Functions.worker_opts()]
      )
    end
  end

  defp pooled? do
    Functions.pool?() and Process.whereis(Pool) != nil
  end

  defp input_bytes(input) do
    IO.iodata_length(Jason.encode_to_iodata!(input))
  rescue
    _error -> 0
  end

  # The result is checked against the optional output schema. A failure here is
  # a bad reply, not a failed invocation: whatever the handler committed stays
  # committed, which is why the answer is `422` and not a rollback.
  defp to_response({:ok, value, commit}, invocation_id, bundle) do
    case Validate.output(bundle, value) do
      :ok ->
        Response.success(value,
          invocation_id: invocation_id,
          version: bundle.version,
          replayed: replayed(commit)
        )

      {:error, issues} ->
        Response.failure(422,
          invocation_id: invocation_id,
          version: bundle.version,
          code: "invalid_output",
          issues: issues
        )
    end
  end

  defp to_response({:error, status, code, details, meta}, invocation_id, bundle) do
    Response.failure(status,
      invocation_id: invocation_id,
      version: bundle.version,
      code: code,
      details: details,
      rejected: Map.get(meta, :rejected)
    )
  end

  defp replayed(nil), do: nil
  defp replayed(%{replayed: replayed}), do: replayed

  # Loader failures are described for an operator without echoing internals or
  # a stack: the status is the classification, the detail is a reason a person
  # can act on.
  defp lookup_details(:digest_mismatch), do: "bundle digest does not match its code"

  defp lookup_details({:duplicate_active_version, {_name, version}}),
    do: "more than one bundle is deployed as version #{version}"

  defp lookup_details({:invalid_bundle, _reason}), do: "the active bundle is invalid"
  defp lookup_details({:loader_failed, _reason}), do: "the bundle could not be loaded"
  defp lookup_details(_reason), do: "the bundle could not be loaded"

  # ---------------------------------------------------------------------------
  # OpenAPI
  # ---------------------------------------------------------------------------

  @doc """
  The published operation for one route, in the shape `Sync.Router` uses.

  `Mix.Tasks.Openapi.Gen.Spec` dispatches here through each route's `:module`,
  so this is the single definition of the functions surface in the spec.
  """
  def openapi_operation(:list_functions) do
    %{
      operationId: "listFunctions",
      summary: "List deployed functions",
      description:
        "Returns one entry per function name that currently has an active version: its " <>
          "name, version, permission posture, and RPC schemas. Code is never returned. " <>
          "Any resolved actor may list; admin is only required to deploy or activate.",
      tags: ["Functions"],
      responses: %{
        "200" => OperationSchema.function_list_response(),
        "401" => OperationSchema.error_response("No resolved actor"),
        "500" => OperationSchema.error_response("The functions store could not be read")
      }
    }
  end

  def openapi_operation(:invoke_function) do
    %{
      operationId: "invokeFunction",
      summary: "Invoke a deployed function",
      description:
        "Runs the function's active version as the authenticated actor and returns its " <>
          "result. The actor needs a `function.<name>` (or `function.*`) grant unless the " <>
          "function declares `access: \"authenticated\"`; access is checked before the params " <>
          "schema, and both are checked before a worker runs. A result that fails the " <>
          "function's output schema is `422 invalid_output` — committed writes stay " <>
          "committed. `invocation_id` and `version` travel in the body and the " <>
          "`x-ebb-invocation-id` / `x-ebb-function-version` headers. An " <>
          "`Idempotency-Key` request header makes a retry reuse the invocation id, so a " <>
          "repeated commit is answered as a replay (`\"replayed\": true`) instead of " <>
          "writing twice.",
      tags: ["Functions"],
      parameters: [
        OperationSchema.path_param("name", "string", "The function name"),
        OperationSchema.idempotency_key_param()
      ],
      requestBody: %{
        required: false,
        content: %{
          "application/json" => %{
            schema: OperationSchema.invoke_request()
          }
        }
      },
      responses: %{
        "200" => OperationSchema.invocation_success_response(),
        "400" =>
          OperationSchema.invocation_failure_response(
            "`invalid_input` with `issues`, or a malformed JSON body"
          ),
        "401" => OperationSchema.invocation_failure_response("Unauthenticated"),
        "403" => OperationSchema.invocation_failure_response("No invoke grant for this function"),
        "404" =>
          OperationSchema.invocation_failure_response(
            "Unknown function, or a name with no active version (including a disabled one)"
          ),
        "408" => OperationSchema.invocation_failure_response("Deadline exceeded; retryable"),
        "413" => OperationSchema.invocation_failure_response("Request body or frame is oversize"),
        "422" =>
          OperationSchema.invocation_failure_response(
            "`invalid_output`, `handler_error`, or `rejected` with a `rejected` list"
          ),
        "429" =>
          OperationSchema.invocation_failure_response("Worker pool is saturated; retryable"),
        "500" => OperationSchema.invocation_failure_response("Platform failure"),
        "503" => OperationSchema.invocation_failure_response("Runner unavailable; retryable")
      }
    }
  end

  def openapi_operation(:upload_function_version) do
    %{
      operationId: "uploadFunctionVersion",
      summary: "Upload a function version",
      description:
        "Stores one bundle as a new `(name, version)` row. Requires the deploy credential " <>
          "in `Authorization: Bearer <admin token>`; holding it never grants invoke " <>
          "permission. The envelope is verified before the row exists — digest, contract, " <>
          "name grammar, and both JSON Schemas — and a version that already exists is `409` " <>
          "rather than a code replacement. `deploymentHash` is an optional `sha256:<hex>` " <>
          "the CLI computes over the code digest and the behaviour-bearing envelope fields; " <>
          "the server stores it verbatim and returns it in the version history, so a deploy " <>
          "whose hash matches the active version can be skipped. Uploading does not activate: " <>
          "the stored version is `retired` until `POST /functions/{name}/activate` points the " <>
          "name at it.",
      tags: ["Functions"],
      parameters: [
        OperationSchema.path_param("name", "string", "The function name"),
        OperationSchema.admin_auth_param()
      ],
      requestBody: %{
        required: true,
        content: %{
          "application/json" => %{
            schema: OperationSchema.upload_request()
          }
        }
      },
      responses: %{
        "201" => OperationSchema.function_version_response("The version was stored, retired"),
        "400" =>
          OperationSchema.error_response(
            "Malformed JSON, or an envelope the bundle validator refuses (`invalid_bundle`)"
          ),
        "401" => OperationSchema.error_response("No resolved actor"),
        "403" => OperationSchema.error_response("Missing or wrong admin credential"),
        "409" => OperationSchema.error_response("This name and version already exists"),
        "413" => OperationSchema.error_response("Upload body exceeds 8 MiB"),
        "422" => OperationSchema.error_response("A stored schema could not be resolved"),
        "500" => OperationSchema.error_response("Platform failure")
      }
    }
  end

  def openapi_operation(:activate_function) do
    %{
      operationId: "activateFunction",
      summary: "Activate a function version",
      description:
        "Makes one uploaded version the name's serving version in a single transaction: " <>
          "whatever was active is retired and the target becomes active. Requires the " <>
          "deploy credential in `Authorization: Bearer <admin token>`. The target's stored " <>
          "schemas are re-resolved first, so a row tampered with after upload cannot become " <>
          "active. Use `POST /functions/{name}/rollback` to return to the previous version.",
      tags: ["Functions"],
      parameters: [
        OperationSchema.path_param("name", "string", "The function name"),
        OperationSchema.admin_auth_param()
      ],
      requestBody: %{
        required: true,
        content: %{
          "application/json" => %{
            schema: OperationSchema.activate_request()
          }
        }
      },
      responses: %{
        "200" => OperationSchema.function_version_response("The version is now active"),
        "400" => OperationSchema.error_response("Malformed body, or a missing/empty version"),
        "401" => OperationSchema.error_response("No resolved actor"),
        "403" => OperationSchema.error_response("Missing or wrong admin credential"),
        "404" => OperationSchema.error_response("Unknown name or version"),
        "422" => OperationSchema.error_response("The target's stored schema cannot be resolved"),
        "500" => OperationSchema.error_response("Platform failure")
      }
    }
  end

  def openapi_operation(:list_function_versions) do
    %{
      operationId: "listFunctionVersions",
      summary: "List a function's version history",
      description:
        "Returns every uploaded version of the name, newest first, with its status, " <>
          "timestamps, pin, creator, and deployment hash. Code is never returned. Requires " <>
          "the deploy credential. A disabled name still lists its versions, which is how an " <>
          "operator finds the version to activate again.",
      tags: ["Functions"],
      parameters: [
        OperationSchema.path_param("name", "string", "The function name"),
        OperationSchema.admin_auth_param()
      ],
      responses: %{
        "200" => OperationSchema.version_history_response(),
        "401" => OperationSchema.error_response("No resolved actor"),
        "403" => OperationSchema.error_response("Missing or wrong admin credential"),
        "404" => OperationSchema.error_response("No version of this name has been uploaded"),
        "500" => OperationSchema.error_response("Platform failure")
      }
    }
  end

  def openapi_operation(:rollback_function) do
    %{
      operationId: "rollbackFunction",
      summary: "Roll back to the previous function version",
      description:
        "Activates the version that was active when the current one was last activated, " <>
          "following the recorded chain (v3 → v2 → v1). A disabled version is never a " <>
          "candidate; re-enabling one is an activation. Requires the deploy credential.",
      tags: ["Functions"],
      parameters: [
        OperationSchema.path_param("name", "string", "The function name"),
        OperationSchema.admin_auth_param()
      ],
      responses: %{
        "200" => OperationSchema.function_version_response("The previous version is active"),
        "401" => OperationSchema.error_response("No resolved actor"),
        "403" => OperationSchema.error_response("Missing or wrong admin credential"),
        "404" => OperationSchema.error_response("The name has no active version"),
        "409" =>
          OperationSchema.error_response("`no_previous_version`: nothing earlier to roll back to"),
        "422" =>
          OperationSchema.error_response(
            "The previous version's stored schema cannot be resolved"
          ),
        "500" => OperationSchema.error_response("Platform failure")
      }
    }
  end

  def openapi_operation(:disable_function) do
    %{
      operationId: "disableFunction",
      summary: "Disable a function",
      description:
        "The per-function kill switch: the active version becomes `disabled`, the name " <>
          "holds no active slot and resolves `404`, and no worker is spawned. Activating " <>
          "a version again re-enables it. Requires the deploy credential. A second disable " <>
          "answers `404` because there is no active version left.",
      tags: ["Functions"],
      parameters: [
        OperationSchema.path_param("name", "string", "The function name"),
        OperationSchema.admin_auth_param()
      ],
      responses: %{
        "200" => OperationSchema.function_version_response("The active version is now disabled"),
        "401" => OperationSchema.error_response("No resolved actor"),
        "403" => OperationSchema.error_response("Missing or wrong admin credential"),
        "404" => OperationSchema.error_response("The name has no active version to disable"),
        "500" => OperationSchema.error_response("Platform failure")
      }
    }
  end
end
