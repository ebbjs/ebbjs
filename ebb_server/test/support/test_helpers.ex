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

  To generate HLC values with specific values, use `hlc_from/2`.
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

  @doc """
  Returns a valid action map with atom keys (validated_action format).
  Used for testing the Writer after PermissionChecker validation.

  Handles both atom and string keys in overrides for convenience.

  ## Examples

      validated_action()  # basic action with random IDs
      validated_action(%{id: "act_123", updates: [update]})  # with atom key overrides
      validated_action(%{"id" => "act_123", "hlc" => 123})  # with string key overrides
  """
  def validated_action(overrides \\ %{}) do
    hlc = generate_hlc()
    update = validated_update()

    base = %{
      id: "act_" <> Nanoid.generate(),
      actor_id: "a_test",
      hlc: hlc,
      updates: [update]
    }

    # Handle both atom and string keys
    result =
      Enum.reduce(overrides, base, fn
        {:id, v}, acc -> Map.put(acc, :id, v)
        {:actor_id, v}, acc -> Map.put(acc, :actor_id, v)
        {:hlc, v}, acc -> Map.put(acc, :hlc, v)
        {:updates, v}, acc -> Map.put(acc, :updates, v)
        {"id", v}, acc -> Map.put(acc, :id, v)
        {"actor_id", v}, acc -> Map.put(acc, :actor_id, v)
        {"hlc", v}, acc -> Map.put(acc, :hlc, v)
        {"updates", v}, acc -> Map.put(acc, :updates, v)
        # Skip other keys
        {_, _}, acc -> acc
      end)

    result
  end

  @doc """
  Returns a valid update map with atom keys (validated_update format).
  Used for testing the Writer after PermissionChecker validation.

  Handles both atom and string keys in overrides for convenience.

  ## Examples

      validated_update()  # basic update with random IDs
      validated_update(%{subject_id: "todo_123", method: :patch})  # with atom key overrides
      validated_update(%{"id" => "upd_123", "subject_id" => "todo_123"})  # with string key overrides
  """
  def validated_update(overrides \\ %{}) do
    hlc = generate_hlc()

    base = %{
      id: "upd_" <> Nanoid.generate(),
      subject_id: "todo_" <> Nanoid.generate(),
      subject_type: "todo",
      method: :put,
      data: %{
        "fields" => %{
          "title" => %{"type" => "lww", "value" => "Buy milk", "hlc" => hlc},
          "completed" => %{"type" => "lww", "value" => false, "hlc" => hlc}
        }
      }
    }

    # Handle both atom and string keys for structural fields
    result =
      Enum.reduce(overrides, base, fn
        {:id, v}, acc -> Map.put(acc, :id, v)
        {:subject_id, v}, acc -> Map.put(acc, :subject_id, v)
        {:subject_type, v}, acc -> Map.put(acc, :subject_type, v)
        {:method, v}, acc -> Map.put(acc, :method, v)
        {:data, v}, acc -> Map.put(acc, :data, v)
        {"id", v}, acc -> Map.put(acc, :id, v)
        {"subject_id", v}, acc -> Map.put(acc, :subject_id, v)
        {"subject_type", v}, acc -> Map.put(acc, :subject_type, v)
        {"method", v}, acc -> Map.put(acc, :method, v)
        {"data", v}, acc -> Map.put(acc, :data, v)
        # Skip other keys
        {_, _}, acc -> acc
      end)

    result
  end
end
