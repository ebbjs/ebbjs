defmodule EbbServer.Bench.Workbook do
  @moduledoc """
  Builds the wire Actions the benchmark writes and pre-seeds the system
  state they depend on.

  Every measured Action is freshly minted (unique `action_id` and update
  ids) so it never hits the idempotency dedup path, which would consume
  zero GSNs and silently inflate the accepted rate.

  The canonical unit is the 2-Update Action from
  `test/support/integration/action_helpers.ex`: a user-entity `put` plus an
  `entityGroup` `put` filing it into the bench group.
  """

  alias EbbServer.Bench.Options
  alias EbbServer.Storage.{ActionValidator, Writer}

  @group_id "g_bench"
  @actor_id "a_bench"
  @permissions ["todo.*", "entityGroup.*"]
  @hot_entity_id "todo_bench_hot"
  @hot_membership_id "eg_bench_hot"
  @seed_batch_size 500

  @type context :: %{
          group_id: String.t(),
          actor_id: String.t(),
          entities: [String.t()],
          hot_entity_id: String.t(),
          hot_membership_id: String.t(),
          seeded_actions: non_neg_integer()
        }

  @doc "The bench group id."
  @spec group_id() :: String.t()
  def group_id, do: @group_id

  @doc "The single bench actor id."
  @spec actor_id() :: String.t()
  def actor_id, do: @actor_id

  @doc """
  Writes the bootstrap group + membership and any preloaded entities
  before the measured window.
  """
  @spec seed(Options.t()) :: context()
  def seed(%Options{} = config) do
    write_actions!([bootstrap_action()])
    entities = seed_entities(preload_count(config))

    if hot?(config), do: write_actions!([seed_action(@hot_entity_id, @hot_membership_id, 0)])

    %{
      group_id: @group_id,
      actor_id: @actor_id,
      entities: entities,
      hot_entity_id: @hot_entity_id,
      hot_membership_id: @hot_membership_id,
      seeded_actions: 1 + length(entities) + if(hot?(config), do: 1, else: 0)
    }
  end

  @doc """
  The Action that creates the bench group and adds `a_bench` to it with
  `todo.*` / `entityGroup.*` permissions.
  """
  @spec bootstrap_action() :: map()
  def bootstrap_action do
    hlc = now_hlc()

    %{
      "id" => "act_bench_bootstrap",
      "actor_id" => @actor_id,
      "hlc" => hlc,
      "updates" => [
        %{
          "id" => "u_bench_group",
          "subject_id" => @group_id,
          "subject_type" => "group",
          "method" => "put",
          "data" => %{
            "fields" => %{
              "name" => %{"type" => "lww", "value" => "Bench Group", "hlc" => hlc}
            }
          }
        },
        %{
          "id" => "u_bench_member",
          "subject_id" => "gm_bench",
          "subject_type" => "groupMember",
          "method" => "put",
          "data" => %{
            "fields" => %{
              "actor_id" => %{"type" => "lww", "value" => @actor_id, "hlc" => hlc},
              "group_id" => %{"type" => "lww", "value" => @group_id, "hlc" => hlc},
              "permissions" => %{"type" => "lww", "value" => @permissions, "hlc" => hlc}
            }
          }
        }
      ]
    }
  end

  @doc """
  A pre-seed Action: a `todo` put plus its `entityGroup` membership.
  """
  @spec seed_action(String.t(), String.t(), non_neg_integer()) :: map()
  def seed_action(entity_id, membership_id, seq) do
    hlc = now_hlc()

    %{
      "id" => "act_seed_#{seq}",
      "actor_id" => @actor_id,
      "hlc" => hlc,
      "updates" => [
        todo_put(entity_id, "title", "seed-#{seq}", seq, hlc, nil),
        entity_group_put(entity_id, membership_id, hlc)
      ]
    }
  end

  @doc """
  Builds one fresh wire Action for the measured window.
  """
  @spec build_action(Options.t(), context(), pos_integer(), non_neg_integer()) :: map()
  def build_action(%Options{} = config, ctx, worker_id, seq) do
    hlc = now_hlc()
    sent_us = System.monotonic_time(:microsecond)
    {entity_id, membership_id} = target(config, ctx, seq)
    updates = updates(config, entity_id, membership_id, worker_id, seq, hlc, sent_us)

    %{
      "id" => "a#{worker_id}_#{unique()}",
      "actor_id" => @actor_id,
      "hlc" => hlc,
      "updates" => updates
    }
  end

  defp target(%{updates_per_action: 1} = config, ctx, seq) do
    pool = if config.distribution == :hot, do: [ctx.hot_entity_id], else: ctx.entities
    {Enum.at(pool, rem(seq, length(pool))), nil}
  end

  defp target(%{distribution: :hot}, ctx, _seq), do: {ctx.hot_entity_id, ctx.hot_membership_id}

  defp target(_config, _ctx, _seq) do
    id = unique()
    {"todo_#{id}", "eg_#{id}"}
  end

  # A 1-Update Action cannot create ownership, so it targets an entity
  # that is already filed into the bench group.
  defp updates(%{updates_per_action: 1}, entity_id, nil, worker_id, seq, hlc, sent_us) do
    [todo_put(entity_id, "title", "w#{worker_id}-#{seq}", seq, hlc, sent_us)]
  end

  defp updates(config, entity_id, membership_id, worker_id, seq, hlc, sent_us) do
    extras =
      for i <- 3..config.updates_per_action//1 do
        todo_put(entity_id, "f#{i}", "w#{worker_id}-#{seq}-#{i}", seq * 100 + i, hlc, nil)
      end

    [
      todo_put(entity_id, "title", "w#{worker_id}-#{seq}", seq, hlc, sent_us),
      entity_group_put(entity_id, membership_id, hlc)
      | extras
    ]
  end

  defp todo_put(entity_id, field, value, seq, hlc, sent_us) do
    fields = %{
      field => %{"type" => "lww", "value" => value, "hlc" => hlc},
      "done" => %{"type" => "lww", "value" => rem(seq, 2) == 0, "hlc" => hlc}
    }

    fields =
      if sent_us do
        Map.put(fields, "bench_sent_us", %{"type" => "lww", "value" => sent_us, "hlc" => hlc})
      else
        fields
      end

    %{
      "id" => "u_#{unique()}",
      "subject_id" => entity_id,
      "subject_type" => "todo",
      "method" => "put",
      "data" => %{"fields" => fields}
    }
  end

  defp entity_group_put(entity_id, membership_id, hlc) do
    %{
      "id" => "u_eg_#{unique()}",
      "subject_id" => membership_id,
      "subject_type" => "entityGroup",
      "method" => "put",
      "data" => %{
        "fields" => %{
          "entity_id" => %{"type" => "lww", "value" => entity_id, "hlc" => hlc},
          "group_id" => %{"type" => "lww", "value" => @group_id, "hlc" => hlc}
        }
      }
    }
  end

  defp seed_entities(0), do: []

  defp seed_entities(count) do
    ids = Enum.map(1..count, fn i -> "todo_seed_#{i}" end)

    ids
    |> Enum.with_index(1)
    |> Enum.chunk_every(@seed_batch_size)
    |> Enum.each(fn chunk ->
      actions = Enum.map(chunk, fn {id, seq} -> seed_action(id, "eg_seed_#{seq}", seq) end)
      write_actions!(actions)
    end)

    ids
  end

  defp write_actions!(actions) do
    validated = Enum.map(actions, &ActionValidator.to_validated_action/1)

    case Writer.write_actions(validated) do
      {:ok, _range, []} -> :ok
      {:ok, _range, rejected} -> raise "seed actions rejected: #{inspect(rejected)}"
      {:error, reason} -> raise "seed write failed: #{inspect(reason)}"
    end
  end

  defp preload_count(%{updates_per_action: 1, distribution: :hot}), do: 0
  defp preload_count(%{updates_per_action: 1} = config), do: max(config.entities, 1)
  defp preload_count(config), do: config.entities

  defp hot?(%{distribution: :hot}), do: true
  defp hot?(_config), do: false

  defp now_hlc, do: System.os_time(:millisecond) * 65_536

  defp unique, do: :erlang.unique_integer([:positive, :monotonic])
end
