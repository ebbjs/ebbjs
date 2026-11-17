defmodule EbbServer.Storage.WriterEnvConfigTest do
  @moduledoc """
  The Writer's deployment knobs are documented in `README.md` as operator
  settings, so a container that only carries environment variables has to be
  able to reach each of them. `Application.get_env/2` stays the first source;
  `EBB_WRITER_*` is the fallback when the key is unset.
  """

  use ExUnit.Case, async: false

  import EbbServer.TestHelpers

  setup do
    cache = start_isolated_cache()
    %{name: rocks_name} = start_rocks()

    Map.put(cache, :rocks_name, rocks_name)
  end

  test "batching knobs come from the environment when no option is given", ctx do
    put_env(%{
      "EBB_WRITER_BATCH_MAX_SIZE" => "250",
      "EBB_WRITER_BATCH_TIMEOUT_MS" => "25"
    })

    state = writer_state(ctx)

    assert state.batch_max_size == 250
    assert state.batch_timeout_ms == 25
  end

  test "prepare knobs come from the environment when no option is given", ctx do
    put_env(%{
      "EBB_WRITER_PREPARE_POOL_SIZE" => "3",
      "EBB_WRITER_PREPARE_QUEUE_MAX" => "48",
      "EBB_WRITER_PREPARE_TIMEOUT_MS" => "750"
    })

    state = writer_state(ctx)

    assert state.prepare.queue_max == 48
    assert state.prepare.timeout_ms == 750
    assert map_size(:sys.get_state(state.prepare.pool).workers) == 3
  end

  test "EBB_WRITER_MAX_IN_FLIGHT sets the overlay depth when no option is given", ctx do
    put_env(%{"EBB_WRITER_MAX_IN_FLIGHT" => "3"})

    state = writer_state(ctx)

    assert state.pipeline.max_in_flight == 3
  end

  test "the application key still wins over the environment", ctx do
    previous = Application.get_env(:ebb_server, :writer_batch_max_size)
    Application.put_env(:ebb_server, :writer_batch_max_size, 77)
    put_env(%{"EBB_WRITER_BATCH_MAX_SIZE" => "250"})

    on_exit(fn ->
      if previous,
        do: Application.put_env(:ebb_server, :writer_batch_max_size, previous),
        else: Application.delete_env(:ebb_server, :writer_batch_max_size)
    end)

    assert writer_state(ctx).batch_max_size == 77
  end

  test "an unset environment keeps every documented default", ctx do
    delete_env([
      "EBB_WRITER_BATCH_MAX_SIZE",
      "EBB_WRITER_BATCH_TIMEOUT_MS",
      "EBB_WRITER_MAX_IN_FLIGHT",
      "EBB_WRITER_PREPARE_POOL_SIZE",
      "EBB_WRITER_PREPARE_QUEUE_MAX",
      "EBB_WRITER_PREPARE_TIMEOUT_MS"
    ])

    state = writer_state(ctx)

    assert state.batch_max_size == 1000
    assert state.batch_timeout_ms == 0
    assert state.pipeline.max_in_flight == 1
    assert map_size(:sys.get_state(state.prepare.pool).workers) == 2
    assert state.prepare.queue_max == 1_024
    assert state.prepare.timeout_ms == 2_000
  end

  test "a non-integer environment value is a boot error", ctx do
    put_env(%{"EBB_WRITER_PREPARE_QUEUE_MAX" => "many"})

    name = :"invalid_env_#{System.unique_integer([:positive])}"
    Process.flag(:trap_exit, true)

    assert {:error, {%ArgumentError{message: message}, _stacktrace}} =
             EbbServer.Storage.Writer.start_link(
               writer_opts(ctx, %{})
               |> Map.to_list()
               |> Keyword.put(:name, name)
             )

    assert message =~ "EBB_WRITER_PREPARE_QUEUE_MAX must be an integer"
  end

  defp writer_state(ctx) do
    %{pid: pid} = start_writer(writer_opts(ctx, %{}))
    :sys.get_state(pid)
  end

  # Writer config is read at `init/1` from process-wide state, so every test
  # here restores what it touched.
  defp put_env(vars) do
    Enum.each(vars, fn {name, value} ->
      previous = System.get_env(name)
      System.put_env(name, value)

      on_exit(fn ->
        if previous,
          do: System.put_env(name, previous),
          else: System.delete_env(name)
      end)
    end)
  end

  defp delete_env(names) do
    Enum.each(names, fn name ->
      previous = System.get_env(name)
      System.delete_env(name)

      on_exit(fn -> if previous, do: System.put_env(name, previous) end)
    end)
  end
end
