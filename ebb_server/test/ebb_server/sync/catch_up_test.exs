defmodule EbbServer.Sync.CatchUpTest do
  use ExUnit.Case, async: false
  use EbbServer.Integration.StorageCase

  import EbbServer.TestHelpers

  alias EbbServer.Integration.ActionHelpers
  alias EbbServer.Storage.{ActionFormat, GroupCache, RocksDB, WatermarkTracker}
  alias EbbServer.Sync.CatchUp

  describe "catch_up_group/3" do
    test "happy path: returns actions sorted by GSN with up_to_date: true" do
      actor_id = "a_happy_#{:erlang.unique_integer([:positive])}"
      group_id = "g_happy_#{:erlang.unique_integer([:positive])}"

      ActionHelpers.bootstrap_group(actor_id, group_id, [
        "todo.read",
        "todo.write",
        "todo.create"
      ])

      entity_id = "todo_#{Nanoid.generate()}"

      ActionHelpers.write_entity_in_group(actor_id, entity_id, "todo", group_id, %{
        "title" => %{
          "type" => "lww",
          "value" => "First Task",
          "hlc" => "2024-01-01T00:00:00.000Z"
        }
      })

      Process.sleep(200)

      {:ok, _actions, meta} = CatchUp.catch_up_group(group_id, actor_id, 0)
      assert meta.up_to_date == true
      assert meta.next_offset == nil
    end

    test "offset filtering: returns only actions with GSN > offset" do
      a_id = "a_offset_#{:erlang.unique_integer([:positive])}"
      g_id = "g_offset_#{:erlang.unique_integer([:positive])}"

      ActionHelpers.bootstrap_group(a_id, g_id, [
        "todo.read",
        "todo.write",
        "todo.create"
      ])

      entity_id = "todo_#{Nanoid.generate()}"

      for i <- 1..3 do
        result =
          ActionHelpers.write_entity_in_group(a_id, entity_id, "todo", g_id, %{
            "title" => %{
              "type" => "lww",
              "value" => "Task #{i}",
              "hlc" => "2024-01-0#{i}T00:00:00.000Z"
            }
          })

        assert result.status == 200
      end

      Process.sleep(200)

      {:ok, actions, _meta} = CatchUp.catch_up_group(g_id, a_id, 2)
      assert length(actions) == 2
      assert Enum.all?(actions, fn a -> a["gsn"] > 2 end)
    end

    test "pagination detection: more than limit triggers next_offset" do
      actor_id = "a_page_#{:erlang.unique_integer([:positive])}"
      group_id = "g_page_#{:erlang.unique_integer([:positive])}"

      ActionHelpers.bootstrap_group(actor_id, group_id, [
        "todo.read",
        "todo.write",
        "todo.create"
      ])

      entity_id = "todo_#{Nanoid.generate()}"

      for i <- 1..250 do
        month = if i < 10, do: "0#{i}", else: Integer.to_string(i)

        result =
          ActionHelpers.write_entity_in_group(actor_id, entity_id, "todo", group_id, %{
            "title" => %{
              "type" => "lww",
              "value" => "Task #{i}",
              "hlc" => "2024-01-#{month}T00:00:00.000Z"
            }
          })

        assert result.status == 200
      end

      Process.sleep(300)

      # bootstrap (1) + 250 writes (2-251) = 251 actions total
      assert {:ok, first_page, meta} = CatchUp.catch_up_group(group_id, actor_id, 0, limit: 200)
      assert length(first_page) == 200
      assert meta.up_to_date == false
      assert is_integer(meta.next_offset)

      assert {:ok, second_page, final_meta} =
               CatchUp.catch_up_group(group_id, actor_id, meta.next_offset, limit: 200)

      # 251 total - 200 first = 51 second page
      assert length(second_page) == 51
      assert final_meta.up_to_date == true
      assert final_meta.next_offset == nil
    end

    test "delivers an Action with no per-Update scopes whole (pre-#473 fallback)" do
      actor_id = "a_legacy_#{:erlang.unique_integer([:positive])}"
      group_id = "g_legacy_#{:erlang.unique_integer([:positive])}"

      ActionHelpers.bootstrap_group(actor_id, group_id, ["todo.read", "todo.create"])
      Process.sleep(100)

      gsn = RocksDB.get_max_gsn() + 1
      hlc = generate_hlc()

      # An Action committed before #473 has no `"update_scopes"`: catch-up
      # must return it whole rather than dropping it.
      legacy = %{
        "id" => "act_legacy_#{:erlang.unique_integer([:positive])}",
        "actor_id" => actor_id,
        "hlc" => hlc,
        "gsn" => gsn,
        "updates" => [
          %{
            "id" => "upd_legacy_#{:erlang.unique_integer([:positive])}",
            "subject_id" => "todo_legacy",
            "subject_type" => "todo",
            "method" => "put",
            "data" => %{
              "fields" => %{"title" => %{"type" => "lww", "value" => "x", "hlc" => hlc}}
            }
          }
        ]
      }

      :ok =
        RocksDB.write_batch([
          {:put, RocksDB.cf_actions(), RocksDB.encode_gsn_key(gsn),
           :erlang.term_to_binary(legacy)},
          {:put, RocksDB.cf_group_actions(), RocksDB.encode_group_action_key(group_id, gsn),
           legacy["id"]}
        ])

      :ok = WatermarkTracker.mark_range_committed(gsn, gsn)
      WatermarkTracker.advance_watermark()

      {:ok, actions, _meta} = CatchUp.catch_up_group(group_id, actor_id, gsn - 1)

      assert [returned] = actions
      assert returned["id"] == legacy["id"]
      assert length(returned["updates"]) == 1
    end

    test "delivers an Action stored in the new GSN-free wrapper shape" do
      actor_id = "a_wrapper_#{:erlang.unique_integer([:positive])}"
      group_id = "g_wrapper_#{:erlang.unique_integer([:positive])}"

      ActionHelpers.bootstrap_group(actor_id, group_id, ["todo.read", "todo.create"])
      Process.sleep(100)

      gsn = RocksDB.get_max_gsn() + 1
      hlc = generate_hlc()
      action_id = "act_wrapper_#{:erlang.unique_integer([:positive])}"
      update_id = "upd_wrapper_#{:erlang.unique_integer([:positive])}"

      payload =
        %{
          id: action_id,
          actor_id: actor_id,
          hlc: hlc,
          updates: [
            %{
              id: update_id,
              subject_id: "todo_wrapper",
              subject_type: "todo",
              method: :put,
              data: %{
                "fields" => %{"title" => %{"type" => "lww", "value" => "x", "hlc" => hlc}}
              }
            },
            %{
              id: "upd_other_#{:erlang.unique_integer([:positive])}",
              subject_id: "todo_other",
              subject_type: "todo",
              method: :put,
              data: %{}
            }
          ]
        }
        |> ActionFormat.build()
        |> ActionFormat.encode()

      # The second Update scopes to another group, so catch-up must use the
      # wrapper's scopes and drop it.
      wrapper = ActionFormat.wrap(payload, [[group_id], ["g_other"]])

      :ok =
        RocksDB.write_batch([
          {:put, RocksDB.cf_actions(), RocksDB.encode_gsn_key(gsn), wrapper},
          {:put, RocksDB.cf_group_actions(), RocksDB.encode_group_action_key(group_id, gsn),
           action_id}
        ])

      :ok = WatermarkTracker.mark_range_committed(gsn, gsn)
      WatermarkTracker.advance_watermark()

      {:ok, actions, _meta} = CatchUp.catch_up_group(group_id, actor_id, gsn - 1)

      assert [returned] = actions
      assert returned["gsn"] == gsn
      assert returned["id"] == action_id
      assert [%{"id" => ^update_id}] = returned["updates"]
    end

    test "non-member rejection: returns {:error, :not_member}" do
      group_id = "g_unknown_#{:erlang.unique_integer([:positive])}"
      non_member_actor = "a_outsider_#{:erlang.unique_integer([:positive])}"

      result = CatchUp.catch_up_group(group_id, non_member_actor, 0)

      assert result == {:error, :not_member}
    end
  end

  describe "bounded page reads (#423)" do
    test "one page consumes at most `limit` index rows and fetches at most `limit` Actions" do
      actor_id = "a_bounded_#{:erlang.unique_integer([:positive])}"
      group_id = "g_bounded_#{:erlang.unique_integer([:positive])}"
      limit = 25

      join_group(actor_id, group_id)

      # Another group's Actions push this group's first GSN well past its own
      # row count, so only a cursor that advances by the last GSN consumed can
      # land where the page ended.
      foreign_group_id = "g_bounded_other_#{:erlang.unique_integer([:positive])}"
      seed_group_rows(actor_id, foreign_group_id, 1..40)

      # Three pages of backlog. Written straight into both column families so
      # the test pays for the read path, not for the Writer.
      first_gsn = RocksDB.get_max_gsn() + 1
      seed_group_rows(actor_id, group_id, first_gsn..(first_gsn + 3 * limit - 1))

      ref = attach_telemetry([[:ebb, :sync, :catch_up_read]])

      assert {:ok, actions, meta} = CatchUp.catch_up_group(group_id, actor_id, 0, limit: limit)

      assert [
               {[:ebb, :sync, :catch_up_read],
                %{index_rows: index_rows, actions_fetched: actions_fetched},
                %{group_id: ^group_id}}
             ] = telemetry_events(ref)

      # The counters are the module's self-report, the only non-mocking way to
      # observe the bound from outside.
      assert index_rows == limit
      assert actions_fetched == limit
      assert length(actions) == limit
      assert meta.up_to_date == false
      assert meta.next_offset == first_gsn + limit - 1
      refute meta.next_offset == length(actions)
    end

    test "treats a non-positive limit as one row instead of scanning the backlog" do
      actor_id = "a_limit_#{:erlang.unique_integer([:positive])}"
      group_id = "g_limit_#{:erlang.unique_integer([:positive])}"

      join_group(actor_id, group_id)
      seed_group_rows(actor_id, group_id, 1..50)

      for limit <- [0, -5] do
        ref = attach_telemetry([[:ebb, :sync, :catch_up_read]])

        assert {:ok, actions, meta} =
                 CatchUp.catch_up_group(group_id, actor_id, 0, limit: limit)

        assert [{[:ebb, :sync, :catch_up_read], %{index_rows: index_rows}, _}] =
                 telemetry_events(ref)

        assert index_rows == 1
        assert length(actions) == 1
        assert meta.up_to_date == false
        assert meta.next_offset == 1
      end
    end
  end

  describe "catch-up across GSN holes (#423)" do
    test "a page with limit > 1 spans a hole and a filtered row" do
      actor_id = "a_span_#{:erlang.unique_integer([:positive])}"
      group_id = "g_span_#{:erlang.unique_integer([:positive])}"

      join_group(actor_id, group_id)

      # The frontier resolves 4..9, so 7 and 8 are holes left by an abandoned
      # sub-range (#536); 6 has an index row but no `cf_actions` row, as a
      # non-atomic commit could leave it.
      seed_group_rows(actor_id, group_id, [4, 6, 9], without_actions: [6])

      assert {:ok, actions, meta} = CatchUp.catch_up_group(group_id, actor_id, 0, limit: 3)

      assert Enum.map(actions, & &1["gsn"]) == [4, 9]
      assert meta.next_offset == 9
      assert meta.up_to_date == false

      assert {[4, 9], %{up_to_date: true, next_offset: nil}} = drain(group_id, actor_id, 3)
    end

    test "paginates over abandoned GSNs and an index row with no Action row" do
      actor_id = "a_hole_#{:erlang.unique_integer([:positive])}"
      group_id = "g_hole_#{:erlang.unique_integer([:positive])}"

      ActionHelpers.bootstrap_group(actor_id, group_id, ["todo.read", "todo.create"])
      Process.sleep(100)

      # GSN 1 is the bootstrap Action. The frontier resolves 2..9, so 5, 7 and
      # 8 are holes left by abandoned sub-ranges (#536); 6 has an index row
      # but no `cf_actions` row, as a non-atomic commit could leave it.
      seed_group_rows(actor_id, group_id, [2, 3, 4, 6, 9], without_actions: [6])

      # A page that resolves nothing at all must still move the cursor.
      assert {:ok, [], hole_meta} = CatchUp.catch_up_group(group_id, actor_id, 5, limit: 1)
      assert hole_meta.next_offset == 6
      assert hole_meta.up_to_date == false

      {gsns, final_meta} = drain(group_id, actor_id, 1)

      assert gsns == [1, 2, 3, 4, 9]
      assert gsns == Enum.sort(gsns)
      assert final_meta.up_to_date == true
      assert final_meta.next_offset == nil
    end
  end

  describe "frontier-0 scan bound (#423)" do
    test "sees durable rows above GSN 999_999 when the frontier is 0" do
      actor_id = "a_frontier0_#{:erlang.unique_integer([:positive])}"
      group_id = "g_frontier0_#{:erlang.unique_integer([:positive])}"

      join_group(actor_id, group_id)

      # Nothing has resolved a range, so the tracker keeps the frontier it
      # seeded from an empty database. Rows exist anyway, and the scan must not
      # stop below them (#423).
      assert WatermarkTracker.committed_watermark() == 0

      gsns = [1_000_001, 1_000_002]
      seed_group_rows(actor_id, group_id, gsns, advance_watermark: false)
      assert WatermarkTracker.committed_watermark() == 0

      assert {:ok, actions, meta} = CatchUp.catch_up_group(group_id, actor_id, 0)

      assert Enum.map(actions, & &1["gsn"]) == gsns
      assert meta.up_to_date == true
    end

    test "does not leak rows of a group whose id extends this one" do
      actor_id = "a_prefix_#{:erlang.unique_integer([:positive])}"
      suffix = :erlang.unique_integer([:positive])
      group_id = "g_pre_#{suffix}"
      longer_group_id = "g_pre_#{suffix}2"

      join_group(actor_id, group_id)
      assert WatermarkTracker.committed_watermark() == 0

      seed_group_rows(actor_id, group_id, [1_000_001, 1_000_002], advance_watermark: false)

      # A pre-#473 record carries no scopes, so a leaked row would be delivered
      # whole to a group it does not belong to.
      seed_group_rows(actor_id, longer_group_id, [1_000_003, 1_000_004],
        advance_watermark: false,
        scopes: :unscoped
      )

      # A page wide enough to reach the longer group's rows.
      assert {:ok, actions, meta} = CatchUp.catch_up_group(group_id, actor_id, 0, limit: 3)

      assert Enum.map(actions, & &1["gsn"]) == [1_000_001, 1_000_002]
      assert meta.up_to_date == true
      assert meta.next_offset == nil

      # Paged one row at a time, the cursor never lands on a foreign GSN.
      assert {[1_000_001, 1_000_002], _final_meta} = drain(group_id, actor_id, 1)
    end
  end

  describe "catch_up_group/4 telemetry" do
    test "emits ebb.sync.catch_up for a full resync from offset 0" do
      actor_id = "a_tel_full_#{:erlang.unique_integer([:positive])}"
      group_id = "g_tel_full_#{:erlang.unique_integer([:positive])}"

      ActionHelpers.bootstrap_group(actor_id, group_id, [
        "todo.read",
        "todo.write",
        "todo.create"
      ])

      entity_id = "todo_#{Nanoid.generate()}"

      ActionHelpers.write_entity_in_group(actor_id, entity_id, "todo", group_id, %{
        "title" => %{
          "type" => "lww",
          "value" => "First Task",
          "hlc" => "2024-01-01T00:00:00.000Z"
        }
      })

      Process.sleep(200)

      ref = attach_telemetry([[:ebb, :sync, :catch_up]])
      {:ok, actions, meta} = CatchUp.catch_up_group(group_id, actor_id, 0)

      assert [
               {[:ebb, :sync, :catch_up], %{count: 1},
                %{
                  group_id: ^group_id,
                  from_offset: 0,
                  returned: returned,
                  up_to_date: true
                }}
             ] = telemetry_events(ref)

      assert returned == length(actions)
      assert meta.up_to_date == true
    end

    test "tags an incremental catch-up with a non-zero from_offset" do
      actor_id = "a_tel_inc_#{:erlang.unique_integer([:positive])}"
      group_id = "g_tel_inc_#{:erlang.unique_integer([:positive])}"

      ActionHelpers.bootstrap_group(actor_id, group_id, [
        "todo.read",
        "todo.write",
        "todo.create"
      ])

      entity_id = "todo_#{Nanoid.generate()}"

      for i <- 1..3 do
        ActionHelpers.write_entity_in_group(actor_id, entity_id, "todo", group_id, %{
          "title" => %{
            "type" => "lww",
            "value" => "Task #{i}",
            "hlc" => "2024-01-0#{i}T00:00:00.000Z"
          }
        })
      end

      Process.sleep(200)

      ref = attach_telemetry([[:ebb, :sync, :catch_up]])
      {:ok, actions, _meta} = CatchUp.catch_up_group(group_id, actor_id, 2)

      assert [
               {[:ebb, :sync, :catch_up], %{count: 1},
                %{group_id: ^group_id, from_offset: 2, returned: returned}}
             ] = telemetry_events(ref)

      assert returned == length(actions)
    end

    test "emits nothing when the actor is not a member" do
      group_id = "g_tel_denied_#{:erlang.unique_integer([:positive])}"
      non_member_actor = "a_tel_denied_#{:erlang.unique_integer([:positive])}"

      ref = attach_telemetry([[:ebb, :sync, :catch_up]])

      assert {:error, :not_member} = CatchUp.catch_up_group(group_id, non_member_actor, 0)
      assert telemetry_events(ref) == []
    end
  end

  # Grants read access without writing an Action, for tests that seed the
  # group's rows directly and need the frontier left where they put it.
  defp join_group(actor_id, group_id) do
    :ok =
      GroupCache.put_group_member(%{
        id: "gm_#{Nanoid.generate()}",
        actor_id: actor_id,
        group_id: group_id,
        permissions: ["todo.read", "todo.create"]
      })
  end

  # Writes the group's index rows for `gsns` and resolves the whole span, the
  # way the Writer resolves a batch: GSNs without a row are abandoned holes.
  # `advance_watermark: false` leaves the frontier untouched, for tests that
  # seed a database whose frontier is still 0.
  defp seed_group_rows(actor_id, group_id, gsns, opts \\ []) do
    index_only = Keyword.get(opts, :without_actions, [])
    action_opts = Keyword.take(opts, [:scopes])

    ops =
      Enum.flat_map(gsns, fn gsn ->
        action_id = "act_seed_#{gsn}_#{:erlang.unique_integer([:positive])}"

        index_op =
          {:put, RocksDB.cf_group_actions(), RocksDB.encode_group_action_key(group_id, gsn),
           action_id}

        if gsn in index_only do
          [index_op]
        else
          [
            {:put, RocksDB.cf_actions(), RocksDB.encode_gsn_key(gsn),
             seeded_action(actor_id, group_id, action_id, action_opts)},
            index_op
          ]
        end
      end)

    :ok = RocksDB.write_batch(ops)

    if Keyword.get(opts, :advance_watermark, true) do
      :ok = WatermarkTracker.mark_range_resolved(Enum.min(gsns), Enum.max(gsns))
      WatermarkTracker.advance_watermark()
    end

    :ok
  end

  # `:scopes` picks the stored shape: `:group` is a current record scoped to the
  # group, `:unscoped` is a pre-#473 record that any group's index row delivers
  # whole.
  defp seeded_action(actor_id, group_id, action_id, opts) do
    hlc = generate_hlc()

    payload =
      %{
        id: action_id,
        actor_id: actor_id,
        hlc: hlc,
        updates: [
          %{
            id: "upd_#{action_id}",
            subject_id: "todo_seed",
            subject_type: "todo",
            method: :put,
            data: %{
              "fields" => %{"title" => %{"type" => "lww", "value" => action_id, "hlc" => hlc}}
            }
          }
        ]
      }
      |> ActionFormat.build()
      |> ActionFormat.encode()

    case Keyword.get(opts, :scopes, :group) do
      :group -> ActionFormat.wrap(payload, [[group_id]])
      :unscoped -> payload
    end
  end

  # Pages from 0 until the stream reports up_to_date, asserting that a page
  # never stalls: with actions [] it must still advance the cursor (#473).
  defp drain(group_id, actor_id, limit, offset \\ 0, seen \\ [], pages \\ 0) do
    assert pages < 20, "catch-up did not reach up_to_date"

    {:ok, actions, meta} = CatchUp.catch_up_group(group_id, actor_id, offset, limit: limit)
    seen = seen ++ Enum.map(actions, & &1["gsn"])

    cond do
      meta.up_to_date ->
        {seen, meta}

      is_nil(meta.next_offset) ->
        flunk("next_offset is nil while up_to_date is false")

      meta.next_offset <= offset ->
        flunk("next_offset #{meta.next_offset} did not advance past #{offset}")

      true ->
        drain(group_id, actor_id, limit, meta.next_offset, seen, pages + 1)
    end
  end
end
