defmodule EbbServer.Bench.Materialize.Workload do
  @moduledoc """
  Builds the entities and patches the materialization benchmark reads.

  A "document" is a `todo` whose `content` field is a wire map field:
  `%{"map" => %{run_key => %{"value" => text, "hlc" => hlc}}}`. The map keys
  are the runs; the benchmark varies how many there are. Each entity is
  filed into its actor's group by an `entityGroup` membership update in the
  same Action, exactly like `EbbServer.Bench.Workbook`'s seed actions.

  Hot and spread entities live in different groups owned by different
  actors so a `query` never returns a hot document, and each size's spread
  pool has its own group so a `query` returning K rows always returns K
  documents of that size.
  """

  alias EbbServer.Storage.{ActionValidator, Writer}

  @actor_hot "a_mz_hot"
  @group_hot "g_mz_hot"
  @permissions ["todo.*", "entityGroup.*"]

  @type context :: %{
          hot: %{pos_integer() => String.t()},
          spread: %{pos_integer() => [String.t()]},
          spread_actors: %{pos_integer() => String.t()}
        }

  @doc "The actor that reads the single hot entity per size."
  @spec actor_hot() :: String.t()
  def actor_hot, do: @actor_hot

  @doc "The actor that reads and queries the spread pool for `size`."
  @spec actor_spread(pos_integer()) :: String.t()
  def actor_spread(size), do: "a_mz_spread_#{size}"

  @doc """
  Seeds the groups and every hot and spread entity, returning their ids.
  """
  @spec seed(EbbServer.Bench.Materialize.Options.t(), non_neg_integer()) :: context()
  def seed(%EbbServer.Bench.Materialize.Options{} = config, _run) do
    write_actions!([bootstrap_action(@actor_hot, @group_hot, "gm_mz_hot")])

    hot = for n <- config.sizes, into: %{}, do: {n, seed_hot_size(config, n)}
    spread = for n <- config.sizes, into: %{}, do: {n, seed_spread_size(config, n)}

    spread_actors = Map.new(config.sizes, fn n -> {n, actor_spread(n)} end)

    %{hot: hot, spread: spread, spread_actors: spread_actors}
  end

  defp seed_hot_size(config, n) do
    entity_id = "mz_hot_#{n}"
    content = content_map(n, config.run_value_bytes)
    action = entity_action(entity_id, "eg_hot_#{n}", @actor_hot, @group_hot, content, "hot #{n}")
    write_actions!([action])
    entity_id
  end

  defp seed_spread_size(config, n) do
    actor_id = actor_spread(n)
    group_id = "g_mz_spread_#{n}"
    write_actions!([bootstrap_action(actor_id, group_id, "gm_mz_spread_#{n}")])

    per = max(div(n, config.spread_entities), 1)
    ids = for i <- 1..config.spread_entities, do: "mz_spread_#{n}_#{i}"

    ids
    |> Enum.with_index(1)
    |> Enum.chunk_every(100)
    |> Enum.each(&write_spread_chunk(&1, config, n, actor_id, group_id, per))

    ids
  end

  defp write_spread_chunk(chunk, config, n, actor_id, group_id, per) do
    actions =
      Enum.map(chunk, fn {id, i} ->
        content = content_map(per, config.run_value_bytes)
        entity_action(id, "eg_spread_#{n}_#{i}", actor_id, group_id, content, "spread #{n} #{i}")
      end)

    write_actions!(actions)
  end

  @doc """
  The merged `data` map for a document with `n` run keys, as stored in
  SQLite. Used by the generated-column ablation to build the same blob.
  """
  @spec content_data(pos_integer(), pos_integer()) :: map()
  def content_data(n, run_value_bytes) do
    %{"fields" => %{"content" => content_map(n, run_value_bytes)}}
  end

  @doc """
  A one-key patch to a document's `content` map.
  """
  @spec patch_action(String.t(), String.t(), String.t(), String.t()) :: map()
  def patch_action(entity_id, actor_id, key, value) do
    hlc = next_hlc()

    %{
      "id" => unique("act"),
      "actor_id" => actor_id,
      "hlc" => hlc,
      "updates" => [
        %{
          "id" => unique("u"),
          "subject_id" => entity_id,
          "subject_type" => "todo",
          "method" => "patch",
          "data" => %{
            "fields" => %{
              "content" => %{"map" => %{key => %{"value" => value, "hlc" => hlc}}}
            }
          }
        }
      ]
    }
  end

  @doc """
  Writes raw Actions through the Writer, raising on any rejection.
  """
  @spec write_actions!([map()]) :: :ok
  def write_actions!(actions) do
    validated = Enum.map(actions, &ActionValidator.to_validated_action/1)

    case Writer.write_actions(validated) do
      {:ok, _range, []} -> :ok
      {:ok, _range, rejected} -> raise "bench actions rejected: #{inspect(rejected)}"
      {:error, reason} -> raise "bench write failed: #{inspect(reason)}"
    end
  end

  # One Action creates the group and adds the actor, mirroring
  # `Workbook.bootstrap_action/0`.
  defp bootstrap_action(actor_id, group_id, membership_id) do
    hlc = next_hlc()

    %{
      "id" => unique("act_bootstrap"),
      "actor_id" => actor_id,
      "hlc" => hlc,
      "updates" => [
        %{
          "id" => unique("u_group"),
          "subject_id" => group_id,
          "subject_type" => "group",
          "method" => "put",
          "data" => %{
            "fields" => %{"name" => %{"type" => "lww", "value" => group_id, "hlc" => hlc}}
          }
        },
        %{
          "id" => unique("u_member"),
          "subject_id" => membership_id,
          "subject_type" => "groupMember",
          "method" => "put",
          "data" => %{
            "fields" => %{
              "actor_id" => %{"type" => "lww", "value" => actor_id, "hlc" => hlc},
              "group_id" => %{"type" => "lww", "value" => group_id, "hlc" => hlc},
              "permissions" => %{"type" => "lww", "value" => @permissions, "hlc" => hlc}
            }
          }
        }
      ]
    }
  end

  defp entity_action(entity_id, membership_id, actor_id, group_id, content, title) do
    hlc = next_hlc()

    %{
      "id" => unique("act_entity"),
      "actor_id" => actor_id,
      "hlc" => hlc,
      "updates" => [
        %{
          "id" => unique("u_entity"),
          "subject_id" => entity_id,
          "subject_type" => "todo",
          "method" => "put",
          "data" => %{
            "fields" => %{
              "title" => %{"type" => "lww", "value" => title, "hlc" => hlc},
              "content" => content
            }
          }
        },
        %{
          "id" => unique("u_eg"),
          "subject_id" => membership_id,
          "subject_type" => "entityGroup",
          "method" => "put",
          "data" => %{
            "fields" => %{
              "entity_id" => %{"type" => "lww", "value" => entity_id, "hlc" => hlc},
              "group_id" => %{"type" => "lww", "value" => group_id, "hlc" => hlc}
            }
          }
        }
      ]
    }
  end

  defp content_map(n, run_value_bytes) do
    hlc = next_hlc()

    %{
      "map" =>
        for i <- 1..n, into: %{} do
          {"run_#{i}", %{"value" => run_value(i, run_value_bytes), "hlc" => hlc}}
        end
    }
  end

  # A stable, per-key value of exactly `bytes` bytes (the key prefix keeps
  # keys distinct without making the JSON unrealistic).
  defp run_value(i, bytes) do
    prefix = "#{i}:"
    String.duplicate("x", max(bytes - byte_size(prefix), 1)) |> then(&(prefix <> &1))
  end

  # Monotonic within a run so a patch always beats the seed value at equal
  # wall-clock milliseconds; the counter shares the HLC's low 16 bits.
  defp next_hlc do
    counter = rem(:erlang.unique_integer([:positive, :monotonic]), 65_536)
    System.os_time(:millisecond) * 65_536 + counter
  end

  defp unique(prefix), do: "#{prefix}_#{:erlang.unique_integer([:positive])}"
end
