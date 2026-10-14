defmodule ActionSink do
  @moduledoc """
  Example `onAction` handler: a stub warehouse sink.

  Copy this module into `ebb_server/lib/` (or your own application),
  rename it, and point the exporter at `handle/1`:

      # ebb_server/config/dev.exs
      config :ebb_server, on_action: {ActionSink, :handle}

  `handle/1` is called once per durably committed Action, in GSN order.
  See `EbbServer.ActionExport` for the full contract and semantics.
  """

  require Logger

  @doc """
  Exports one committed Action to the sink, one row per Update.

  Returns `:ok` to advance the export cursor. Return `{:error, reason}`
  (or raise, throw, exit, or run past the handler timeout) to stall the
  cursor and have the batch re-delivered.
  """
  @spec handle(map()) :: :ok | {:error, term()}
  def handle(action) do
    Enum.each(action["updates"], &write_row(action, &1))
    :ok
  end

  defp write_row(action, update) do
    row = %{
      action_id: action["id"],
      actor_id: action["actor_id"],
      hlc: action["hlc"],
      gsn: action["gsn"],
      update_id: update["id"],
      subject_type: update["subject_type"],
      subject_id: update["subject_id"],
      method: update["method"],
      data: update["data"]
    }

    # Delivery is at-least-once: a failed batch leaves the cursor where it
    # was and the whole batch is retried, so this row can arrive twice.
    # Upsert on `{action_id, update_id}` (or dedup explicitly) rather than
    # a plain insert.
    Logger.info("[action_sink] #{inspect(row)}")
  end
end
