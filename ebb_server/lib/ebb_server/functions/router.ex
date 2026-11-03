defmodule EbbServer.Functions.Router do
  @moduledoc """
  `POST /functions/:name` — invoke one function.

  The route is mounted by `EbbServer.Sync.Router` only when
  `EbbServer.Functions.enabled?/0` is true. When it is false the parent router
  never calls this module, so the path falls through to its ordinary
  catch-all: absent, not "disabled". See `EbbServer.Functions` for why the flag
  is resolved once at boot.

  `AuthPlug` runs before the route, so a request without an identity is
  refused by that shared plug with its usual `401 unauthorized` body. The
  branch below is the same answer for a caller that reached this router
  directly, with the functions envelope attached.

  ## One invocation id, always

  An `invocation_id` is minted before anything is looked up, so every response
  — success, unknown function, denied, malformed body, timeout — carries one in
  the body and in `x-ebb-invocation-id`. By default it is `"inv_" <> nanoid(16)`
  over the same `[0-9a-z]` alphabet as `generateId("inv")`, so it belongs to the
  one id space the storage layer indexes.

  ## Idempotency-Key

  A request may carry one `Idempotency-Key` header. With it, the invocation id
  is derived from the key instead of minted:
  `"inv_" <> first16(lowercase_hex(sha256(actor_id <> "\n" <> name <> "\n" <> key)))`,
  still 16 characters of the same alphabet. `EbbServer.Functions.Host` derives
  the Action id from the invocation id, so a retry of the same request
  reproduces the same `action_id`; `cf_action_dedup` drops the second copy
  before it claims a GSN, and the response carries `"replayed": true`.

  The key is scoped to the actor and the function, because it is a value the
  caller chooses: two callers that happen to pick the same string are not
  retrying the same request, and must not share a dedup key. Within that scope
  a repeated key silently drops whatever content the retry carries, including
  a retry whose handler produced different writes. The first commit under that
  `action_id` is the durable one and every later one is answered as a replay.
  Only send the header when the request is safe to repeat unchanged; a key is
  not a way to perform a second, different write. One invocation commits at
  most one Action, so this also holds within a single request.

  An empty key, a key longer than 255 bytes, or the header repeated is a `400`
  rather than a derived id: requests that disagree about what was meant must
  not end up sharing a dedup key. Such a response still carries a freshly
  minted invocation id, because the body names the invocation that refused.

  ## Order of work

  1. Read the body within a size limit.
  2. Resolve the active bundle through `EbbServer.Functions.BundleCache`.
  3. Authorize with `EbbServer.Functions.Access` — before any worker is
     spawned, so a denied request costs nothing.
  4. Build the `invoke` frame and hand it to
     `EbbServer.Functions.Invocation.run/1`.

  A tampered or broken bundle is a `500`, never a `404`: a digest mismatch is
  not a typo in the URL, and answering `not_found` for a bundle that exists but
  fails verification would hide a bad deploy.

  ## Size limit

  The request body is read with `#{EbbServer.Functions.Protocol.max_frame_bytes()}`
  bytes — 1 MiB, i.e. the protocol frame bound — as its limit, in 64 KiB
  chunks, so an oversize body is refused without being buffered whole. That is
  this slice's derived limit rather than a separate number: the body becomes
  the `input` field of the `invoke` frame, so a body bigger than the frame
  bound can never fit, and a smaller one still might not once the bundle's code
  is added. The assembled frame is therefore measured before it is sent, and
  either case answers `413 payload_too_large` through
  `EbbServer.Functions.Response`.

  ## Options

  Router options exist so tests can avoid the registered process and the
  application's ETS tables. They are read from the assign
  `copy_opts_to_assign` gives them, because `Plug.Router` compiles function
  plugs with their options at build time:

    * `:cache` — the `EbbServer.Functions.BundleCache` to ask (default
      `EbbServer.Functions.BundleCache`)
    * `:group_members_table` — the ETS table holding grants (default
      `EbbServer.Storage.CacheTables.group_members/0`)

  Everything else (the worker transport, its options, and the bundle
  directory) comes from `EbbServer.Functions` config, because it describes the
  node rather than the request.
  """

  use Plug.Router, copy_opts_to_assign: :functions_opts

  alias EbbServer.Functions
  alias EbbServer.Functions.{Access, BundleCache, Invocation, Protocol, Response}
  alias EbbServer.Storage.CacheTables

  # The body of an `invoke` frame is the bundle's code plus this request's
  # input; a request body can never usefully be larger than a whole frame.
  @max_body_bytes Protocol.max_frame_bytes()
  @read_chunk_bytes 64 * 1024
  @idempotency_key_header "idempotency-key"
  @max_idempotency_key_bytes 255
  # Handed to the runner in the invoke frame. The runner is what counts calls
  # (plan §2.12); v1's only ops are one pure read and one commit, so the server
  # has nothing to count here yet.
  @max_host_calls 1000

  plug(:match)
  plug(:dispatch)

  post "/:name" do
    name = conn.path_params["name"]
    actor_id = conn.assigns[:actor_id]

    case idempotency_key(conn) do
      {:ok, key} ->
        case actor_id do
          nil -> respond(conn, Response.failure(401, invocation_id: new_invocation_id()))
          actor -> invoke(conn, name, actor, invocation_id_for(actor, name, key))
        end

      {:error, details} ->
        respond(conn, invalid_key_response(details))
    end
  end

  # `Plug.Router` requires a catch-all. The parent only forwards
  # `["functions", name]`, so this answers a wrong method exactly as the
  # parent's own catch-all would.
  match _ do
    conn |> Plug.Conn.send_resp(404, "") |> Plug.Conn.halt()
  end

  defp cache(conn) do
    Keyword.get(conn.assigns.functions_opts, :cache, BundleCache)
  end

  defp group_members_table(conn) do
    Keyword.get(
      conn.assigns.functions_opts,
      :group_members_table,
      CacheTables.group_members()
    )
  end

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

  defp invocation_id_for(_actor_id, _name, nil), do: new_invocation_id()
  defp invocation_id_for(actor_id, name, key), do: derived_invocation_id(actor_id, name, key)

  # The actor and function scope the key: it is caller-chosen, so two callers
  # that pick the same string are not retrying the same request.
  defp derived_invocation_id(actor_id, name, key) do
    digest =
      :crypto.hash(:sha256, [actor_id, "\n", name, "\n", key])
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

  defp invoke(conn, name, actor_id, invocation_id) do
    case active_bundle(conn, name, invocation_id) do
      {:ok, bundle} ->
        authorize(conn, bundle, actor_id, invocation_id)

      {:error, response} ->
        respond(conn, response)
    end
  end

  # An empty body is no parameters; a JSON body must be an object because the
  # frame's `input` is the function's argument map.
  defp read_input(conn) do
    case Plug.Conn.read_body(conn, length: @max_body_bytes, read_length: @read_chunk_bytes) do
      {:ok, "", conn} ->
        {:ok, %{}, conn}

      {:ok, body, conn} ->
        decode_input(body, conn)

      {:more, _partial, conn} ->
        {:error, 413, "request body exceeds #{@max_body_bytes} bytes", conn}

      {:error, _reason} ->
        {:error, 400, "request body could not be read", conn}
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
  # params are #595's to validate, and a denied caller should not be able to
  # make the server read a megabyte first.
  defp authorize(conn, bundle, actor_id, invocation_id) do
    table = group_members_table(conn)

    case Access.authorize(bundle.access, actor_id, bundle.name, table: table) do
      :ok ->
        read_and_execute(conn, bundle, actor_id, invocation_id)

      {:error, :denied} ->
        respond(
          conn,
          Response.failure(403, invocation_id: invocation_id, version: bundle.version)
        )
    end
  end

  defp read_and_execute(conn, bundle, actor_id, invocation_id) do
    case read_input(conn) do
      {:ok, input, conn} ->
        respond(conn, execute(bundle, actor_id, invocation_id, input))

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

  defp execute(bundle, actor_id, invocation_id, input) do
    frame = invoke_frame(bundle, actor_id, invocation_id, input)

    if Protocol.fits?(frame) do
      bundle
      |> run_invocation(frame)
      |> to_response(invocation_id, bundle.version)
    else
      Response.failure(413,
        invocation_id: invocation_id,
        version: bundle.version,
        details: "invoke frame exceeds #{Protocol.max_frame_bytes()} bytes"
      )
    end
  end

  defp invoke_frame(bundle, actor_id, invocation_id, input) do
    Protocol.invoke(%{
      "invocation_id" => invocation_id,
      "name" => bundle.name,
      "version" => bundle.version,
      "digest" => bundle.digest,
      "bundle" => bundle.code,
      "entry" => bundle.entry,
      "input" => input,
      "subject_actor_id" => actor_id,
      # Secrets are #597; v1 hands a function no environment.
      "env" => %{},
      "limits" => %{"timeout_ms" => bundle.timeout_ms, "max_host_calls" => @max_host_calls}
    })
  end

  defp run_invocation(bundle, frame) do
    Invocation.run(
      transport: Functions.transport(),
      invoke: frame,
      worker_opts: Functions.worker_opts(),
      deadline_ms: bundle.timeout_ms
    )
  end

  defp to_response({:ok, value, commit}, invocation_id, version) do
    Response.success(value,
      invocation_id: invocation_id,
      version: version,
      replayed: replayed(commit)
    )
  end

  defp to_response({:error, status, code, details, meta}, invocation_id, version) do
    Response.failure(status,
      invocation_id: invocation_id,
      version: version,
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

  # Every body and header is built by `Response`; this is the only place that
  # writes them to the conn.
  defp respond(conn, {status, body, headers} = response) do
    case Jason.encode(body) do
      {:ok, json} -> send_body(conn, status, json, headers)
      {:error, _reason} -> respond(conn, unencodable(response))
    end
  end

  defp unencodable({_status, body, _headers}) do
    Response.failure(500,
      invocation_id: body["invocation_id"],
      version: body["version"],
      details: "response could not be encoded"
    )
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
end
