defmodule EbbServer.Storage.ActionSubmission do
  @moduledoc """
  The write seam: validation and authorization, then the Writer, then one
  rejection list.

  `submit/3` is the sequence `POST /sync/actions` runs and the one the
  function runtime's `ctx.commit` will use, so both surface the same
  rejections in the same shape. A caller that runs the two calls itself
  has to rediscover that a batch rejected in full never reaches the
  Writer and that permission and writer rejections are reported together.

  `{:ok, {0, 0}, rejections}` means no GSN was assigned to this caller —
  every Action was rejected, already durable, or already in flight. It
  does not mean the Actions are durable; see `EbbServer.Storage.Writer`.

  A Writer call that exits — including the 5 s `GenServer.call/2` timeout —
  becomes `{:error, {:write_exit, reason}}` instead of escaping to the HTTP
  request process. For a timeout the outcome is unknown, not failed: the
  Writer may still commit, so the caller retries idempotently.
  """

  alias EbbServer.Storage.{PermissionChecker, Writer}

  @type rejection :: %{required(String.t()) => String.t()}

  @spec submit([PermissionChecker.raw_action()], String.t(), keyword()) ::
          {:ok, {non_neg_integer(), non_neg_integer()}, [rejection()]} | {:error, term()}
  def submit(actions, actor_id, opts \\ []) do
    {accepted, permission_rejected} =
      PermissionChecker.validate_and_authorize(actions, actor_id, opts)

    if accepted == [] do
      # The Writer is not asked to write an empty batch: no Actions survived
      # validation, so no GSN belongs to this caller.
      {:ok, {0, 0}, format_rejections(permission_rejected)}
    else
      # The Router owns HTTP mapping; this seam owns the shared exit contract.
      try do
        case Writer.write_actions(accepted, Keyword.get(opts, :writer_name, Writer)) do
          {:ok, gsn_range, writer_rejected} ->
            rejections =
              format_rejections(permission_rejected) ++ format_writer_rejections(writer_rejected)

            {:ok, gsn_range, rejections}

          {:error, _reason} = error ->
            error
        end
      catch
        :exit, reason -> {:error, {:write_exit, reason}}
      end
    end
  end

  defp format_rejections(rejections) do
    Enum.map(rejections, fn %{action_id: id, reason: reason, details: details} ->
      format_rejection(id, reason, details)
    end)
  end

  defp format_writer_rejections(rejections) do
    Enum.map(rejections, fn %{action: action, reason: reason} = rejection ->
      format_rejection(action.id, reason, Map.get(rejection, :details))
    end)
  end

  defp format_rejection(id, reason, details) do
    rejection = %{"id" => id, "reason" => reason}
    if details, do: Map.put(rejection, "details", details), else: rejection
  end
end
