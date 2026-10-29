defmodule EbbServer.Functions.Worker.Fake do
  @moduledoc """
  An in-process worker scripted by data.

  The step list is the conformance fixture format: `send` a frame, `expect` a
  partially matching frame, `exit` without a `result`, or hand the rest of the
  scenario to a named function. Running a fixture against this transport and
  the real invocation loop is how the host side of the protocol is specified.

  A missing frame needs no script — an empty list waits for the invocation
  deadline. `expect` retains frames that do not match, so two outstanding host
  calls may be answered in either order: replies are matched by their content,
  never by arrival position.

  The function escape hatch exists for scenarios a step list does not express.
  It receives `send` and `expect` functions and owns the rest of the scenario;
  when it returns the fake idles until the host closes it.
  """

  @type step :: map()
  @type handle :: %{pid: pid()}
  @type api :: %{send: (map() -> :ok), expect: (map() -> map()), owner: pid()}

  @default_expect_timeout_ms 5_000

  @doc """
  Starts a fake worker.

  Options:

    * `:script` — the step list (default `[]`)
    * `:scripts` — named functions for `{"script": name}` steps
    * `:owner` — the process frames are delivered to (default the caller)
    * `:expect_timeout` — how long an `expect` waits before the fake exits
  """
  @spec start(keyword()) :: {:ok, handle()}
  def start(opts \\ []) do
    state = %{
      steps: Keyword.get(opts, :script, []),
      scripts: Keyword.get(opts, :scripts, %{}),
      owner: Keyword.get(opts, :owner, self()),
      expect_timeout: Keyword.get(opts, :expect_timeout, @default_expect_timeout_ms),
      awaited: []
    }

    pid = spawn(fn -> loop(state) end)
    {:ok, %{pid: pid}}
  end

  @doc """
  Sends a decoded frame to the fake. The fake decides whether it matches the
  step it is waiting on.
  """
  @spec send_frame(handle(), map()) :: :ok | {:error, :closed}
  def send_frame(%{pid: pid}, frame) do
    if Process.alive?(pid) do
      send(pid, {:functions_host_frame, frame})
      :ok
    else
      {:error, :closed}
    end
  end

  @spec close(handle()) :: :ok
  def close(%{pid: pid}) do
    send(pid, :functions_close)
    :ok
  end

  @spec os_pid(handle()) :: nil
  def os_pid(_handle), do: nil

  @spec alive?(handle()) :: boolean()
  def alive?(%{pid: pid}), do: Process.alive?(pid)

  @spec monitor(handle()) :: reference()
  def monitor(%{pid: pid}), do: Process.monitor(pid)

  defp loop(%{steps: [step | rest]} = state) do
    run_step(step, %{state | steps: rest})
  end

  defp loop(%{steps: []} = state), do: idle(state)

  # Once the script is done — or a function script has taken over — the host may
  # still send frames. They are dropped rather than answered: the scenario has
  # already said what it wants to say.
  defp idle(state) do
    receive do
      {:functions_host_frame, _frame} -> idle(state)
      :functions_close -> :ok
    end
  end

  defp run_step(%{"send" => frame}, state) when is_map(frame) do
    deliver(state, frame)
    loop(state)
  end

  defp run_step(%{"expect" => pattern}, state) when is_map(pattern) do
    await(pattern, state)
  end

  defp run_step(%{"exit" => "now"}, _state), do: exit(:worker_exit)

  defp run_step(%{"script" => name}, state) do
    run_script(name, state)
  end

  defp run_step(step, _state), do: exit({:invalid_step, step})

  defp await(pattern, state) do
    case take_match(state.awaited, pattern) do
      {:ok, _frame, awaited} ->
        loop(%{state | awaited: awaited})

      :error ->
        receive do
          {:functions_host_frame, frame} ->
            if matches?(pattern, frame) do
              loop(state)
            else
              await(pattern, %{state | awaited: [frame | state.awaited]})
            end

          :functions_close ->
            exit(:normal)
        after
          state.expect_timeout -> exit({:expect_timeout, pattern})
        end
    end
  end

  defp run_script(name, state) do
    case Map.fetch(state.scripts, name) do
      {:ok, script} ->
        api = %{
          send: fn frame -> deliver(state, frame) end,
          expect: fn pattern -> script_expect(pattern, state.awaited, state.expect_timeout) end,
          owner: state.owner
        }

        script.(api)
        idle(state)

      :error ->
        exit({:unknown_script, name})
    end
  end

  defp script_expect(pattern, awaited, timeout) do
    case take_match(awaited, pattern) do
      {:ok, frame, _awaited} ->
        frame

      :error ->
        receive do
          {:functions_host_frame, frame} ->
            script_expect(pattern, [frame | awaited], timeout)

          :functions_close ->
            exit(:normal)
        after
          timeout -> exit({:expect_timeout, pattern})
        end
    end
  end

  defp take_match(frames, pattern) do
    case Enum.find_index(frames, &matches?(pattern, &1)) do
      nil -> :error
      index -> {:ok, Enum.at(frames, index), List.delete_at(frames, index)}
    end
  end

  defp matches?(expected, actual) when is_map(expected) and is_map(actual) do
    Enum.all?(expected, fn {key, value} ->
      Map.has_key?(actual, key) and matches?(value, Map.fetch!(actual, key))
    end)
  end

  defp matches?(expected, actual) when is_list(expected) and is_list(actual) do
    length(expected) == length(actual) and
      Enum.all?(Enum.zip(expected, actual), fn {expected_item, actual_item} ->
        matches?(expected_item, actual_item)
      end)
  end

  defp matches?(expected, actual), do: expected == actual

  defp deliver(state, frame) do
    send(state.owner, {:functions_worker_frame, frame})
    :ok
  end
end
