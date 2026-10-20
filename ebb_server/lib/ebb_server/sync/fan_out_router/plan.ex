defmodule EbbServer.Sync.FanOutRouter.Plan do
  @moduledoc """
  Pure ordering state for live fan-out.

  The Router shells out to this module for the decision of which committed
  GSN ranges may be dispatched to GroupServers. The state is only data:
  claimed-but-unreleased ranges in claim order, which of those the Writer
  has acknowledged as committed, and the highest GSN ever pushed.

  ## Release order

  A range is released only when two conditions hold:

  - the Writer has acknowledged it as committed (`release/3` records the
    ack), and
  - its end is at or below the committed watermark.

  Releases walk the claimed ranges from the head and stop at the first
  claim that is not yet acknowledged or is still above the watermark.
  That prefix rule is what keeps `last_pushed_gsn` from advancing past an
  unpushed range: a later range cannot be released while an earlier claim
  is still open, even when the watermark already covers both.

  A Writer that notifies in claim order can use `process_batch/4`, which
  claims and acknowledges a range in one step. A Writer with concurrent
  commit acks claims every range up front (sequencer order), then calls
  `release/3` in whatever order the acks arrive. An abandoned claim is a
  hole; `resolve/2` drops it so the release walk can continue past it. An
  unresolved claim blocks every later release, so whoever claims a range
  must resolve it when it is abandoned.

  ## Frontier

  `last_pushed_gsn` only moves forward: it is the maximum end of the
  released ranges, never a rewind from a duplicate or overlapping
  sub-frontier notification.
  """

  @type gsn :: non_neg_integer()
  @type gsn_range :: {gsn(), gsn()}

  @type t :: %__MODULE__{
          pending_notifications: [gsn_range()],
          acked: MapSet.t(gsn_range()),
          last_pushed_gsn: gsn()
        }

  defstruct pending_notifications: [],
            acked: MapSet.new(),
            last_pushed_gsn: 0

  @doc """
  Builds a plan, optionally seeded from a persisted frontier.

  Seed `pending_notifications` with ranges that are already committed (for
  example the ranges recovered from the log after a restart); `new/1`
  orders them by GSN and marks every seeded range as acknowledged. Use
  `claim/2` followed by `release/3` when claims become known before their
  commits do.
  """
  @spec new(keyword()) :: t()
  def new(opts \\ []) do
    pending =
      opts
      |> Keyword.get(:pending_notifications, [])
      |> Enum.sort_by(&elem(&1, 0))

    %__MODULE__{
      pending_notifications: pending,
      acked: Keyword.get(opts, :acked, MapSet.new(pending)),
      last_pushed_gsn: Keyword.get(opts, :last_pushed_gsn, 0)
    }
  end

  @doc """
  Records a claimed-but-unreleased range, ordered by its GSN start.

  The sequencer claims ranges in ascending GSN order, so ordering by
  `from_gsn` is the claim order and also keeps a notification that arrives
  out of order from overtaking an already-buffered earlier range.
  Claiming a range already present is a no-op, so a duplicate notification
  cannot create a second release slot for the same GSNs.
  """
  @spec claim(t(), gsn_range()) :: t()
  def claim(%__MODULE__{} = plan, range) do
    if range in plan.pending_notifications do
      plan
    else
      pending = Enum.sort_by([range | plan.pending_notifications], &elem(&1, 0))
      %{plan | pending_notifications: pending}
    end
  end

  @doc """
  Acknowledges a claimed range and returns the ranges now safe to dispatch.

  A range that was never claimed is claimed first, which preserves the
  Router's pre-#534 message contract: a `batch_committed` notification is
  both the claim and the ack. Pre-register claims with `claim/2` when acks
  can arrive out of order.

  Returns `{released, plan}`, where `released` is in claim order and the
  returned plan no longer holds them.
  """
  @spec release(t(), gsn_range(), gsn()) :: {[gsn_range()], t()}
  def release(%__MODULE__{} = plan, acked_range, watermark) do
    plan
    |> claim(acked_range)
    |> Map.update!(:acked, &MapSet.put(&1, acked_range))
    |> split_pushable(watermark)
  end

  @doc """
  Acknowledges a committed range and drains the releasable prefix.

  Equivalent to `release(plan, {from, to}, watermark)` for a Writer that
  notifies in claim order.
  """
  @spec process_batch(t(), gsn(), gsn(), gsn()) :: {[gsn_range()], t()}
  def process_batch(%__MODULE__{} = plan, from_gsn, to_gsn, watermark) do
    release(plan, {from_gsn, to_gsn}, watermark)
  end

  @doc """
  Drops a resolved hole from the claim order.

  The Writer abandons a claimed range when its commit fails and asks the
  Router to re-drain via `{:range_resolved, ...}`. Removing the claim here
  lets a later acknowledged range become releasable without pushing the
  abandoned GSNs, which have no durable Actions.

  The Writer resolves whole claimed ranges, so the match is exact. A
  partial overlap is left in place rather than guessed at: releasing it
  could push GSNs that were not actually resolved.
  """
  @spec resolve(t(), gsn_range()) :: t()
  def resolve(%__MODULE__{} = plan, range) do
    %{
      plan
      | pending_notifications: Enum.reject(plan.pending_notifications, &(&1 == range)),
        acked: MapSet.delete(plan.acked, range)
    }
  end

  @doc """
  Splits the claim order at the first range that is not releasable.

  A range is releasable when it has been acknowledged and its end is at or
  below `watermark`. Only the prefix is released; everything from the
  first blocked claim onward stays pending. Returns `{released, plan}`
  with `last_pushed_gsn` advanced to the highest released end.
  """
  @spec split_pushable(t(), gsn()) :: {[gsn_range()], t()}
  def split_pushable(%__MODULE__{} = plan, watermark) do
    {released, remaining} =
      take_releasable(plan.pending_notifications, plan.acked, watermark, [])

    released = Enum.reverse(released)

    last_pushed_gsn =
      Enum.reduce(released, plan.last_pushed_gsn, fn {_from, to}, frontier ->
        max(to, frontier)
      end)

    acked = Enum.reduce(released, plan.acked, &MapSet.delete(&2, &1))

    {released,
     %{
       plan
       | pending_notifications: remaining,
         acked: acked,
         last_pushed_gsn: last_pushed_gsn
     }}
  end

  defp take_releasable([], _acked, _watermark, acc), do: {acc, []}

  defp take_releasable([{_, to} = range | rest], acked, watermark, acc) do
    if to <= watermark and MapSet.member?(acked, range) do
      take_releasable(rest, acked, watermark, [range | acc])
    else
      {acc, [range | rest]}
    end
  end
end
