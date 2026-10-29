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
  """

  alias EbbServer.Storage.{ActionSubmission, EntityView}

  @type context :: %{required(:actor_id) => String.t()}
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

  The commit is fail-whole: a rejection returns `422` with the reason, and a
  Writer failure returns `500` with an explicitly unknown outcome. A failure
  never claims that nothing was written, because an abandoned GSN range is not
  proof that the commit did not land.
  """
  @spec commit(term(), context(), keyword()) :: {:ok, nil} | {:error, error()}
  def commit(payload, context, opts \\ []) do
    with :ok <- ensure_action(payload) do
      action = Map.put(payload, "actor_id", context.actor_id)

      case ActionSubmission.submit([action], context.actor_id, opts) do
        {:ok, _gsn_range, []} ->
          {:ok, nil}

        {:ok, _gsn_range, rejections} ->
          {:error, rejection_error(rejections)}

        {:error, _reason} ->
          {:error, failure(500, "write_failed", "the write outcome is unknown")}
      end
    end
  end

  defp entity_id(%{"id" => id}) when is_binary(id) and id != "", do: {:ok, id}
  defp entity_id(_payload), do: {:error, protocol_error("get payload must carry a non-empty id")}

  defp ensure_action(payload) when is_map(payload), do: :ok

  defp ensure_action(_payload) do
    {:error, protocol_error("commit payload must be an Action object")}
  end

  defp rejection_error([first | _rest]) do
    details =
      case first do
        %{"details" => details} when is_binary(details) -> "#{first["reason"]}: #{details}"
        %{"reason" => reason} -> to_string(reason)
        _ -> "action rejected"
      end

    failure(422, "rejected", details)
  end

  defp failure(status, code, details) do
    %{"error" => code, "status" => status, "details" => details}
  end

  defp protocol_error(message), do: failure(500, "protocol_error", message)
end
