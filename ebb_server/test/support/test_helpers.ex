defmodule EbbServer.TestHelpers do
  @moduledoc """
  Shared test helper functions for EbbServer tests.
  """

  import Bitwise

  @doc """
  Creates a unique temporary directory for the test and registers
  an `on_exit` callback to clean it up.

  Returns the path to the created directory.
  """
  def tmp_dir(%{module: module, test: test}) do
    dir =
      Path.join([
        System.tmp_dir!(),
        "ebb_server_test",
        "#{inspect(module)}_#{test}_#{System.unique_integer([:positive])}"
      ])

    File.mkdir_p!(dir)

    ExUnit.Callbacks.on_exit(fn ->
      File.rm_rf!(dir)
    end)

    dir
  end

  @doc """
  Generates a 64-bit HLC timestamp from the current wall clock time.

  The HLC is encoded as: (logical_time_ms << 16) | counter.
  For test helpers the counter is always 0 since we don't need to
  distinguish sub-millisecond events in most tests.

  To generate HLCs with specific values, use `hlc_from/2`.
  """
  def generate_hlc do
    Bitwise.bsl(System.os_time(:millisecond), 16)
  end

  @doc """
  Builds a 64-bit HLC from an explicit logical time (ms) and counter.

  Useful for tests that need deterministic HLC values or need to test
  tiebreaker behavior with equal logical times but different counters.

  ## Examples

      hlc_from(1_710_000_000_000, 0)  # logical time with counter 0
      hlc_from(1_710_000_000_000, 1)  # same ms, next event
  """
  def hlc_from(logical_time_ms, counter \\ 0) when counter >= 0 and counter <= 0xFFFF do
    Bitwise.bsl(logical_time_ms, 16) ||| counter
  end

  @doc """
  Returns a valid action map with string keys.

  Accepts an optional map of overrides that will be merged on top.
  """
  def sample_action(overrides \\ %{}) do
    Map.merge(
      %{
        "id" => "act_" <> Nanoid.generate(),
        "actor_id" => "a_test",
        "hlc" => generate_hlc(),
        "updates" => [sample_update()]
      },
      overrides
    )
  end

  @doc """
  Returns a valid update map with string keys.

  Accepts an optional map of overrides that will be merged on top.
  """
  def sample_update(overrides \\ %{}) do
    hlc = generate_hlc()

    Map.merge(
      %{
        "id" => "upd_" <> Nanoid.generate(),
        "subject_id" => "todo_" <> Nanoid.generate(),
        "subject_type" => "todo",
        "method" => "put",
        "data" => %{
          "fields" => %{
            "title" => %{"type" => "lww", "value" => "Buy milk", "hlc" => hlc},
            "completed" => %{"type" => "lww", "value" => false, "hlc" => hlc}
          }
        }
      },
      overrides
    )
  end
end
