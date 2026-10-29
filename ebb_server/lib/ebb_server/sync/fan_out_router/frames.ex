defmodule EbbServer.Sync.FanOutRouter.Frames do
  @moduledoc """
  Builds the SSE frames for one released fan-out range.

  The Router splits a range into `{group_id, action_with_subset}` memberships,
  one per (Action, recipient group). A group's copy of an Action differs from
  another group's only in which Updates it carries, so encoding per group redoes
  the JSON work for every recipient. This module encodes each distinct
  `(Action, Update subset)` once and hands every group that shares the subset
  the same binary.

  Memberships should arrive grouped by Action, which is how the Router emits
  them. An interleaved caller is still correct — it just re-encodes instead of
  reusing.

  Pure: no process, no cache across ranges. The memo covers one `build/1`
  call, which is one released range.
  """

  alias EbbServer.Sync.SSEConnection

  @type action :: %{required(String.t()) => term()}
  @type membership :: {String.t(), action()}
  @type frames :: %{String.t() => [binary()]}

  @spec build(Enumerable.t(membership())) :: frames()
  def build(memberships) do
    {reversed, _memo} =
      Enum.reduce(memberships, {%{}, nil}, fn {group_id, action}, {frames, memo} ->
        {frame, memo} = frame_for(action, memo)
        {Map.update(frames, group_id, [frame], &[frame | &1]), memo}
      end)

    Map.new(reversed, fn {group_id, group_frames} -> {group_id, Enum.reverse(group_frames)} end)
  end

  # The memo tracks one Action at a time, and the first membership usually
  # carries every Update, so comparing against it avoids allocating Update ids
  # per group. An interleaved caller resets the memo and re-encodes rather than
  # sharing a frame across Actions.
  defp frame_for(action, memo) do
    action_id = action["id"]
    updates = action["updates"] || []

    action_memo =
      case memo do
        %{action_id: ^action_id} = current -> current
        _ -> %{action_id: action_id, first: updates, first_frame: nil, partial: %{}}
      end

    cond do
      action_memo.first_frame != nil and updates == action_memo.first ->
        {action_memo.first_frame, action_memo}

      is_nil(action_memo.first_frame) and updates == action_memo.first ->
        encode_and_store(action, action_memo, :first_frame)

      true ->
        partial_frame(action, updates, action_memo)
    end
  end

  # Partial subsets are the strict case (per-Update scopes differ), so the key
  # is the exact subset: its Update ids complete the Action id, and the frame
  # and the key cannot disagree.
  defp partial_frame(action, updates, action_memo) do
    key = Enum.map(updates, & &1["id"])

    case action_memo.partial do
      %{^key => frame} ->
        {frame, action_memo}

      _ ->
        frame = SSEConnection.data_frame(action)
        {frame, %{action_memo | partial: Map.put(action_memo.partial, key, frame)}}
    end
  end

  defp encode_and_store(action, action_memo, slot) do
    frame = SSEConnection.data_frame(action)
    {frame, Map.put(action_memo, slot, frame)}
  end
end
