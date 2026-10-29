defmodule EbbServer.Sync.FanOutRouter.FramesTest do
  @moduledoc """
  `Frames.build/1` is the one place a fan-out range is encoded: it turns the
  Router's `{group_id, action_with_subset}` memberships into per-group frame
  lists, encoding each distinct `(Action, Update subset)` once. These tests
  need no Router, GroupServer, or storage.
  """

  use ExUnit.Case, async: true

  alias EbbServer.Sync.FanOutRouter.Frames
  alias EbbServer.Sync.SSEConnection

  describe "build/1" do
    test "pins the pre-#658 wire bytes for a fixed Action set" do
      first = %{"id" => "upd_1", "field" => "a"}
      second = %{"id" => "upd_2", "field" => "b"}

      action = %{
        "id" => "act_fixed",
        "gsn" => 7,
        "actor_id" => "a_frames",
        "hlc" => 7_000,
        "updates" => [first, second]
      }

      memberships = [
        {"g_all", action},
        {"g_one", Map.put(action, "updates", [second])}
      ]

      full =
        "event: data\n" <>
          "data: {\"actor_id\":\"a_frames\",\"gsn\":7,\"hlc\":7000,\"id\":\"act_fixed\"," <>
          "\"updates\":[{\"field\":\"a\",\"id\":\"upd_1\"},{\"field\":\"b\",\"id\":\"upd_2\"}]}\n\n"

      subset =
        "event: data\n" <>
          "data: {\"actor_id\":\"a_frames\",\"gsn\":7,\"hlc\":7000,\"id\":\"act_fixed\"," <>
          "\"updates\":[{\"field\":\"b\",\"id\":\"upd_2\"}]}\n\n"

      assert Frames.build(memberships) == %{"g_all" => [full], "g_one" => [subset]}
    end

    test "an empty range yields no frames" do
      assert Frames.build([]) == %{}
    end

    test "a whole-set membership yields the same bytes as data_frame/1 per Action" do
      actions = [
        action("act_1", [update("upd_1"), update("upd_2")], 1),
        action("act_2", [update("upd_3")], 2)
      ]

      memberships = for action <- actions, group_id <- ["g_a", "g_b"], do: {group_id, action}

      expected = Enum.map(actions, &SSEConnection.data_frame/1)

      assert Frames.build(memberships) == %{"g_a" => expected, "g_b" => expected}
    end

    test "a strict Update subset yields the bytes of that subset, per group" do
      [first, second] = updates = [update("upd_a"), update("upd_b")]

      # One Action whose Updates scope to different groups, so each group
      # receives a strict subset of `updates`.
      scoped =
        action("act_scoped", updates, 1)
        |> Map.put("update_scopes", [["g_a"], ["g_b"]])

      memberships = [
        {"g_a", Map.put(scoped, "updates", [first])},
        {"g_b", Map.put(scoped, "updates", [second])}
      ]

      frames = Frames.build(memberships)

      assert frames["g_a"] == [SSEConnection.data_frame(Map.put(scoped, "updates", [first]))]
      assert frames["g_b"] == [SSEConnection.data_frame(Map.put(scoped, "updates", [second]))]
      refute frames["g_a"] == frames["g_b"]
    end

    test "the same Action and Update subset reaching several groups shares its bytes" do
      scoped =
        action("act_shared", [update("upd_1"), update("upd_2")], 1)
        |> Map.put("update_scopes", [["g_a", "g_b"], ["g_a"]])

      memberships = [
        {"g_a", Map.put(scoped, "updates", [update("upd_1"), update("upd_2")])},
        {"g_b", Map.put(scoped, "updates", [update("upd_1")])},
        {"g_c", Map.put(scoped, "updates", [update("upd_1")])}
      ]

      frames = Frames.build(memberships)

      assert frames["g_b"] == frames["g_c"]
      refute frames["g_a"] == frames["g_b"]
    end

    test "a shared subset is reused even when a strict subset arrives first" do
      [first, second] = [update("upd_a"), update("upd_b")]

      scoped =
        action("act_partial_first", [first, second], 1)
        |> Map.put("update_scopes", [["g_a", "g_b"], ["g_b"]])

      memberships = [
        {"g_a", Map.put(scoped, "updates", [first])},
        {"g_b", Map.put(scoped, "updates", [first, second])},
        {"g_c", Map.put(scoped, "updates", [first])}
      ]

      frames = Frames.build(memberships)

      assert frames["g_a"] == frames["g_c"]
      refute frames["g_a"] == frames["g_b"]
    end

    test "the memo key is the Update subset, not the Action id alone" do
      [first, second] = [update("upd_a"), update("upd_b")]

      scoped =
        action("act_key", [first, second], 1)
        |> Map.put("update_scopes", [["g_a", "g_b"], ["g_b"]])

      memberships = [
        {"g_a", Map.put(scoped, "updates", [first])},
        {"g_b", Map.put(scoped, "updates", [first, second])}
      ]

      assert Frames.build(memberships) == %{
               "g_a" => [SSEConnection.data_frame(Map.put(scoped, "updates", [first]))],
               "g_b" => [SSEConnection.data_frame(Map.put(scoped, "updates", [first, second]))]
             }
    end

    test "the memo key is the Action id, not the Update subset alone" do
      updates = [update("upd_a")]

      first = action("act_one", updates, 1)
      second = action("act_two", updates, 2)

      frames = Frames.build([{"g_a", first}, {"g_b", second}])

      assert frames["g_a"] == [SSEConnection.data_frame(first)]
      assert frames["g_b"] == [SSEConnection.data_frame(second)]
      refute frames["g_a"] == frames["g_b"]
    end

    test "per-group order follows the Action order of the memberships" do
      first = action("act_1", [update("upd_1")], 1)
      second = action("act_2", [update("upd_2")], 2)
      third = action("act_3", [update("upd_3")], 3)

      memberships = [
        {"g_a", first},
        {"g_b", first},
        {"g_a", second},
        {"g_b", third},
        {"g_a", third}
      ]

      frames = Frames.build(memberships)

      assert frames["g_a"] == Enum.map([first, second, third], &SSEConnection.data_frame/1)
      assert frames["g_b"] == Enum.map([first, third], &SSEConnection.data_frame/1)
    end

    test "accepts a lazy memberships stream" do
      actions = [action("act_1", [update("upd_1")], 1), action("act_2", [update("upd_2")], 2)]

      memberships = Stream.map(actions, &{"g_a", &1})

      assert Frames.build(memberships) == %{
               "g_a" => Enum.map(actions, &SSEConnection.data_frame/1)
             }
    end
  end

  defp action(id, updates, gsn) do
    %{
      "id" => id,
      "gsn" => gsn,
      "actor_id" => "a_frames",
      "hlc" => gsn * 1_000,
      "updates" => updates
    }
  end

  defp update(id) do
    %{
      "id" => id,
      "subject_id" => "s_#{id}",
      "subject_type" => "todo",
      "method" => "put",
      "data" => %{"fields" => %{"title" => %{"type" => "lww", "value" => id, "hlc" => 1}}}
    }
  end
end
