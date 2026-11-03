defmodule EbbServer.Functions.Host do
  @moduledoc """
  The host operations a running function may call.

  This is the only functions module that reaches storage and permissions, and
  it does so only through the shared seams: `EntityView.for_actor/3` for reads
  and `ActionSubmission.submit/3` for writes. The HTTP endpoints use the same
  seams, so a function sees the same view, the same permission rule, and the
  same rejection shape as a client.

  The actor always comes from the invocation context, never from the frame. A
  worker cannot name another actor in a `commit` payload and impersonate them.

  In v1 the only ops are `get` and `commit`. `get_many` and `query` do not
  exist, so an unlisted op is a protocol error rather than a silent `null`.

  ## One Action per invocation

  `commit` overwrites whatever `id` the frame carries with
  `"a_" <> first16(lowercase_hex(sha256(invocation_id)))` — the same
  16-character `[0-9a-z]` alphabet `generateId/1` uses in `@ebbjs/core`, so the
  dedup key stays in one id space. The invocation id comes from
  `EbbServer.Functions.Router`, which mints it or derives it from an
  `Idempotency-Key` header; a worker cannot choose the Action id any more than
  it can choose the actor.

  Deriving the id is what makes a retry idempotent: the same invocation id
  reproduces the same Action id, and `cf_action_dedup` drops the second copy
  before it claims a GSN. It also means a second `commit` in the same
  invocation targets the id of the first, so its Updates are silently dropped
  and the reply says `"replayed": true`. A handler that writes twice does not
  get two Actions; one invocation commits at most one Action.

  ## Commit replies

  A commit success is the wire value `{"replayed": boolean}` — `true` only for
  `{:ok, {0, 0}, []}`, which means no GSN was assigned to this caller (already
  durable or in flight), and `false` otherwise.

  A rejection is `422 rejected` with `details` carrying the first rejection's
  text and `rejected` carrying `ActionSubmission.submit/3`'s list verbatim.
  `POST /sync/actions` returns that same list of `{"id", "reason", "details"?}`
  maps, because both paths run the same seam. A `{:error, _}` from the Writer
  is `500 write_failed` with an explicitly unknown outcome.
  """

  alias EbbServer.Storage.{ActionSubmission, EntityView}

  @type context :: %{
          required(:actor_id) => String.t(),
          required(:invocation_id) => String.t()
        }
  @type error :: %{required(String.t()) => term()}

  @doc """
  Dispatches one worker `call` frame.
  """
  @spec dispatch(String.t(), term(), context(), keyword()) ::
          {:ok, term()} | {:error, error()}
  def dispatch(op, payload, context, opts \\ [])

  def dispatch("get", payload, context, opts), do: get(payload, context, opts)
  def dispatch("commit", payload, context, opts), do: commit(payload, context, opts)

  def dispatch(op, _payload, _context, _opts) do
    {:error, protocol_error("unsupported host op: #{inspect(op)}")}
  end

  @doc """
  Reads one entity as the invocation's actor.

  A missing entity and an entity the actor may not read both return `nil`: a
  distinct result would make the read an existence oracle.
  """
  @spec get(term(), context(), keyword()) :: {:ok, term()} | {:error, error()}
  def get(payload, context, opts \\ []) do
    with {:ok, entity_id} <- entity_id(payload) do
      case EntityView.for_actor(entity_id, context.actor_id, opts) do
        {:ok, view} -> {:ok, view}
        :not_found -> {:ok, nil}
        {:error, reason} -> {:error, failure(500, "read_failed", inspect(reason))}
      end
    end
  end

  @doc """
  Submits one Action as the invocation's actor.

  The id and the actor are both server-owned: the frame's `id` is replaced by
  the id derived from `context.invocation_id`, and its `actor_id` by
  `context.actor_id`. The reply is `{:ok, %{"replayed" => boolean}}`; `true`
  means the Action was already durable or in flight and no GSN was assigned.

  The commit is fail-whole: a rejection returns `422` with the reason and the
  rejection list, and a Writer failure returns `500` with an explicitly unknown
  outcome. A failure never claims that nothing was written, because an
  abandoned GSN range is not proof that the commit did not land.
  """
  @spec commit(term(), context(), keyword()) ::
          {:ok, %{String.t() => boolean()}} | {:error, error()}
  def commit(payload, context, opts \\ []) do
    with {:ok, invocation_id} <- invocation_id(context),
         :ok <- ensure_action(payload) do
      action =
        payload
        |> Map.put("id", action_id(invocation_id))
        |> Map.put("actor_id", context.actor_id)

      case ActionSubmission.submit([action], context.actor_id, opts) do
        {:ok, {0, 0}, []} ->
          {:ok, %{"replayed" => true}}

        {:ok, _gsn_range, []} ->
          {:ok, %{"replayed" => false}}

        {:ok, _gsn_range, rejections} ->
          {:error, rejection_error(rejections)}

        {:error, _reason} ->
          {:error, failure(500, "write_failed", "the write outcome is unknown")}
      end
    end
  end

  @doc """
  The Action id one invocation's commit carries.

  Deriving it from the invocation id rather than reading the frame's `id` is
  what makes a retry with the same `Idempotency-Key` dedupe: the retry
  reproduces the id, and `cf_action_dedup` drops it before a GSN is claimed.
  The 16-character suffix is the same `[0-9a-z]` id space `generateId/1` uses.
  """
  @spec action_id(String.t()) :: String.t()
  def action_id(invocation_id) do
    digest = Base.encode16(:crypto.hash(:sha256, invocation_id), case: :lower)
    "a_" <> binary_part(digest, 0, 16)
  end

  defp invocation_id(%{invocation_id: id}) when is_binary(id) and id != "", do: {:ok, id}

  defp invocation_id(_context) do
    {:error, protocol_error("the invocation context carries no invocation_id")}
  end

  defp entity_id(%{"id" => id}) when is_binary(id) and id != "", do: {:ok, id}
  defp entity_id(_payload), do: {:error, protocol_error("get payload must carry a non-empty id")}

  defp ensure_action(payload) when is_map(payload), do: :ok

  defp ensure_action(_payload) do
    {:error, protocol_error("commit payload must be an Action object")}
  end

  defp rejection_error([first | _rest] = rejections) do
    details =
      case first do
        %{"details" => details} when is_binary(details) -> "#{first["reason"]}: #{details}"
        %{"reason" => reason} -> to_string(reason)
        _ -> "action rejected"
      end

    failure(422, "rejected", details)
    |> Map.put("rejected", rejections)
  end

  defp failure(status, code, details) do
    %{"error" => code, "status" => status, "details" => details}
  end

  defp protocol_error(message), do: failure(500, "protocol_error", message)
end
