defmodule EbbServer.Functions.Log do
  @moduledoc """
  Writes a function's log frames to the server's Logger, capped per invocation.

  The runner turns `ctx.log` and `console.*` into `log` frames. This module is
  the one place they become Logger lines, tagged with `function_name`,
  `version`, and `invocation_id`, so an operator can find every line an
  invocation produced. The key is `function_name`, not `function`: Logger
  already owns `:function` for the logging call site, and printing both would
  add a stack frame to every line. The server adds no value of its own to a
  line, so nothing here reveals a secret it was not handed.

  Caps are enforced by the caller (`EbbServer.Functions.Invocation`) because
  the budget is per invocation: 200 lines and 64 KiB by default. Once either is
  spent, further lines are dropped and one truncation line is written.
  A flood can fill the log, but it cannot fail the invocation or grow the
  server's memory: the dropped frames are decoded and discarded one at a time.

  Secrets travel in the invoke frame, never through this path; the server adds
  no environment value to a metadata field. A handler that prints its own
  `ctx.env` is doing so deliberately, under the same trust as its code.
  """

  require Logger

  @levels %{
    "debug" => :debug,
    "info" => :info,
    "log" => :info,
    "warn" => :warning,
    "warning" => :warning,
    "error" => :error
  }

  @type level :: String.t()
  @type budget :: %{lines: non_neg_integer(), bytes: non_neg_integer(), truncated: boolean()}
  @type meta :: %{name: String.t(), version: String.t(), invocation_id: String.t()}

  @doc "The zero budget for a new invocation."
  @spec new_budget() :: budget()
  def new_budget, do: %{lines: 0, bytes: 0, truncated: false}

  @doc """
  Writes one log frame if the budget still has room.

  Returns the (possibly exhausted) budget. `:truncated` writes the single
  notice and marks the budget so later frames are dropped silently.
  """
  @spec emit(level(), term(), meta(), budget(), pos_integer(), pos_integer()) :: budget()
  def emit(level, message, meta, budget, max_lines, max_bytes) do
    text = to_text(message)
    size = byte_size(text)

    cond do
      budget.truncated ->
        budget

      budget.lines + 1 > max_lines or budget.bytes + size > max_bytes ->
        truncation_notice(meta, max_lines, max_bytes)
        %{budget | truncated: true}

      true ->
        write(level, text, meta)
        %{budget | lines: budget.lines + 1, bytes: budget.bytes + size}
    end
  end

  @doc "Writes the one truncation notice for an invocation."
  @spec truncation_notice(meta(), pos_integer(), pos_integer()) :: :ok
  def truncation_notice(meta, max_lines, max_bytes) do
    write(
      "warn",
      "log output truncated after #{max_lines} lines / #{max_bytes} bytes",
      meta
    )
  end

  defp write(level, text, meta) do
    Logger.log(
      Map.get(@levels, to_string(level), :info),
      fn -> text end,
      function_name: meta.name,
      version: meta.version,
      invocation_id: meta.invocation_id
    )
  end

  # A frame is JSON, so a message that is not a string already arrived as a
  # decoded term. Inspecting it keeps one line per frame and never raises.
  defp to_text(text) when is_binary(text), do: text
  defp to_text(other), do: inspect(other, limit: 50, printable_limit: 4_096)
end
