defmodule EbbServer.Storage.CommitPipeline do
  @moduledoc """
  Pure state machine for the Writer's commit pipeline and the ordering
  state that gates durable commits, apply, and fan-out.

  The Writer is the imperative shell: it owns the live caches, the
  Committer pool, timers, and the durable side effects. This module owns the
  bookkeeping that used to be spread across the Writer's `pending`,
  `inflight`, `flush_*`, `InFlightActions`, and release-order fields. Every
  transition is a pure function of the pipeline state and an event, so the
  state machine is testable without a Writer, caches, or RocksDB.

  ## Batch lifecycle

  A pipeline with no claimed range is `:idle`. Once a range is claimed it
  moves through one phase:

      idle -> claimed -> prepared -> committing -> committed -> applying -> released
                   \\          \\             \\            \\
                    `----------`-------------`------------`--> abandoned

  `claimed` means the range exists and its action ids are guarded against a
  second claim. `prepared` means group resolution, `update_scopes`, and the
  provisional dirty marks are attached. `committing` means the batch is at
  a Committer worker and `owner` names that worker. `committed` is the
  durable point of no return; from there the batch may still be abandoned
  if a post-ack step raises before the durable mark. `applying` covers the
  ordered apply/notify pass and `released` is its terminal success.
  `abandoned` is terminal and resolved, so its range is a hole in the log
  rather than a stalled claim. `phase/1` reports the phase of the oldest
  open batch, or `:idle`.

  ## One owner for ordering and guard state

  The state machine is the single owner of these decisions:

  - **In-flight guard.** `in_flight_ids` is the Writer's ordered view of
    the ids claimed by batches that are not yet durable or abandoned. The
    atomic cross-process claim is delegated to
    `EbbServer.Storage.InFlightActions`, whose ETS set is the lock-free
    projection; this module decides when an id is released.
  - **Resolution order.** `claim_order` is the ordered list of open ranges,
    oldest first. A batch may not be released (applied and notified) until
    every earlier claimed range has been released or abandoned.
  - **Watermark and fan-out.** `gsn_start`/`gsn_end` on each batch are the
    only ranges the shell may mark committed, resolved, or notify. The
    persisted projections remain `EbbServer.Storage.WatermarkTracker` and
    `EbbServer.Sync.FanOutFrontier`, but their writer-side ordering comes
    from here.

  ## V2 extension points

  The V0 Writer still allows one in-flight batch; `new/1` takes
  `max_in_flight: 1` by default and `schedule/3` stalls once the pipeline is
  at that depth. Depth above one is an internal test seam until the overlay
  (#533) and the full ordered frontier/release work (#534) land. The state
  machine itself is multi-batch: property tests drive several claims and
  arbitrary ack orders through it.

  - **Reorder buffer (#534).** `claim_order` is the buffer and
    `releasable/1` is the ordered release decision: it returns only the
    committed batches at the head of the buffer, stopping at the first
    range that is still committing or already applying. The Writer's
    apply/notify stage walks that list, marks each batch applying, applies
    it, and calls `release/2`. Notifications use the same list, so the
    persisted `FanOutFrontier` cannot pass an unpushed range. At a test
    depth above one the resolution frontier may still advance over a
    durable range before its apply; #534 owns tightening that ordering.
  - **Overlay chain (#533).** The `Batch` struct is where #533 adds the
    cache mutations a batch plans before it is applied. The chain is the
    `claim_order` sequence filtered to batches with a planned overlay;
    `abandon/3` must drop the failed batch's overlay, and `release/2` must
    prune the applied one. Successor batches must be rebuilt rather than
    applied against an abandoned predecessor's overlay.
  """

  alias EbbServer.Storage.PreparedAction

  @type gsn :: non_neg_integer()
  @type gsn_range :: {gsn(), gsn()} | :empty
  @type action_id :: String.t()
  @type payload_etf :: binary()
  @type validated_action :: EbbServer.Storage.PermissionChecker.validated_action()
  @type enqueued_action :: {validated_action(), payload_etf()}
  @type pending_call :: {GenServer.from(), [enqueued_action()]}
  @type pending_marks :: {[PreparedAction.entity_mark()], non_neg_integer() | nil}

  @type phase ::
          :idle
          | :claimed
          | :prepared
          | :committing
          | :committed
          | :applying
          | :released
          | :abandoned

  defmodule Batch do
    @moduledoc """
    One claimed GSN range and everything the Writer needs to resolve it.

    The struct is the named replacement for the ad-hoc `inflight` map the
    Writer used to carry. `phase` is owned by `CommitPipeline`; the other
    fields are immutable input for the transition that consumes them.
    """

    @enforce_keys [
      :ref,
      :gsn_start,
      :gsn_end,
      :action_ids,
      :pending,
      :ranges,
      :started_at,
      :batch_size
    ]
    defstruct [
      :ref,
      :gsn_start,
      :gsn_end,
      :action_ids,
      :pending,
      :ranges,
      :started_at,
      :prepared,
      :groups_by_gsn,
      :batch_size,
      :owner,
      :reason,
      pending_marks: {[], nil},
      phase: :claimed
    ]

    @type t :: %__MODULE__{
            ref: reference(),
            gsn_start: CommitPipeline.gsn(),
            gsn_end: CommitPipeline.gsn(),
            action_ids: [CommitPipeline.action_id()],
            pending: [CommitPipeline.pending_call()],
            ranges: %{optional(non_neg_integer()) => CommitPipeline.gsn_range()},
            started_at: integer(),
            prepared: [PreparedAction.t()] | nil,
            groups_by_gsn: %{optional(CommitPipeline.gsn()) => [String.t()]} | nil,
            pending_marks: CommitPipeline.pending_marks() | nil,
            batch_size: non_neg_integer(),
            owner: pid() | nil,
            reason: term(),
            phase: CommitPipeline.phase()
          }
  end

  @type t :: %__MODULE__{
          pending: [pending_call()],
          pending_count: non_neg_integer(),
          batches: %{optional(reference()) => Batch.t()},
          claim_order: [reference()],
          in_flight_ids: MapSet.t(action_id()),
          flush_scheduled: boolean(),
          flush_timer: boolean(),
          max_in_flight: pos_integer()
        }

  defstruct pending: [],
            pending_count: 0,
            batches: %{},
            claim_order: [],
            in_flight_ids: MapSet.new(),
            flush_scheduled: false,
            flush_timer: false,
            max_in_flight: 1

  @spec new(keyword()) :: t()
  def new(opts \\ []) do
    %__MODULE__{max_in_flight: Keyword.get(opts, :max_in_flight, 1)}
  end

  @doc """
  Records a caller and its pre-encoded Actions as pending.

  The payload build and encode already happened in the Writer before the
  call reaches this transition, so nothing here touches a cache or storage.
  """
  @spec enqueue(t(), GenServer.from(), [enqueued_action()]) :: t()
  def enqueue(%__MODULE__{} = state, from, actions) do
    %{
      state
      | pending: [{from, actions} | state.pending],
        pending_count: state.pending_count + length(actions)
    }
  end

  @doc """
  Decides what the Writer should do after a call arrived or a batch finished.

  Returns one of `:flush` (flush synchronously now), `:send_flush` (queue a
  burst-drain marker), `:schedule_timer` (start the coalescing timer),
  `:wait` (a commit or timer is already in flight), or `:idle` (nothing
  pending). The returned state records the logical timer/marker flags; the
  shell owns the actual timer reference and mailbox send.
  """
  @spec schedule(t(), integer(), non_neg_integer()) ::
          {:flush | :send_flush | :schedule_timer | :wait | :idle, t()}
  def schedule(%__MODULE__{} = state, batch_max_size, batch_timeout_ms) do
    cond do
      at_capacity?(state) ->
        {:wait, state}

      state.pending == [] ->
        {:idle, %{state | flush_scheduled: false}}

      batch_max_size > 0 and state.pending_count >= batch_max_size ->
        {:flush, state}

      state.flush_timer ->
        {:wait, state}

      batch_timeout_ms > 0 ->
        {:schedule_timer, %{state | flush_timer: true}}

      state.flush_scheduled ->
        {:wait, state}

      true ->
        {:send_flush, %{state | flush_scheduled: true}}
    end
  end

  @doc """
  Takes the pending burst for one flush, oldest caller first.

  Clears the pending list and both coalescing flags. A stale `:flush` marker
  that arrives after this is a no-op.
  """
  @spec take_pending(t()) :: {t(), [pending_call()]}
  def take_pending(%__MODULE__{} = state) do
    pending = Enum.reverse(state.pending)

    {%{state | pending: [], pending_count: 0, flush_scheduled: false, flush_timer: false},
     pending}
  end

  @spec clear_flush_marker(t()) :: t()
  def clear_flush_marker(%__MODULE__{} = state), do: %{state | flush_scheduled: false}

  @spec clear_timer(t()) :: t()
  def clear_timer(%__MODULE__{} = state), do: %{state | flush_timer: false}

  @doc """
  Registers a claimed GSN range and guards its action ids.

  The Writer claims the ids in the `InFlightActions` ETS guard and the GSN
  range before calling this; this transition takes ownership of the
  ordering and release bookkeeping for that claim. Depth is enforced by
  `schedule/3` before a claim is made, so this transition is total and the
  Writer cannot fail after consuming a GSN range.
  """
  @spec claim(t(), Batch.t()) :: {:ok, Batch.t(), t()}
  def claim(%__MODULE__{} = state, %Batch{} = batch) do
    state = %{
      state
      | batches: Map.put(state.batches, batch.ref, batch),
        claim_order: state.claim_order ++ [batch.ref],
        in_flight_ids: MapSet.union(state.in_flight_ids, MapSet.new(batch.action_ids))
    }

    {:ok, batch, state}
  end

  @doc "Attaches the prepared batch, group snapshot, and provisional marks."
  @spec prepared(t(), reference(), [PreparedAction.t()], map(), pending_marks()) ::
          {:ok, Batch.t(), t()} | {:error, term()}
  def prepared(%__MODULE__{} = state, ref, prepared, groups_by_gsn, pending_marks) do
    update(state, ref, [:claimed], :prepared, fn batch ->
      %{
        batch
        | prepared: prepared,
          groups_by_gsn: groups_by_gsn,
          pending_marks: pending_marks
      }
    end)
  end

  @doc """
  Marks the batch as handed to the Committer and records the worker that
  owns the range.

  The owner is informational for the Writer: the pool reports the result
  and any worker death by `ref`, so a restart or reassignment cannot make
  the Writer resolve another range's claim. `nil` keeps the transition
  usable in the pure tests that do not model a worker.
  """
  @spec committing(t(), reference(), pid() | nil) :: {:ok, Batch.t(), t()} | {:error, term()}
  def committing(%__MODULE__{} = state, ref, owner \\ nil) do
    update(state, ref, [:prepared], :committing, fn batch -> %{batch | owner: owner} end)
  end

  @doc """
  Records the worker assigned to a committing range.

  The pool dispatches asynchronously, so the Writer learns the owner after
  the claim has already been handed over. Assigning is idempotent and only
  valid while the range is committing.
  """
  @spec assign_owner(t(), reference(), pid()) :: {:ok, Batch.t(), t()} | {:error, term()}
  def assign_owner(%__MODULE__{} = state, ref, owner) do
    update(state, ref, [:committing], :committing, fn batch -> %{batch | owner: owner} end)
  end

  @doc """
  Marks the durable commit and releases the batch's in-flight id guard.

  The Writer still owns the ETS release; `Batch.action_ids` is the exact set
  to release. This transition makes the ordering state agree that the ids
  are durable, so a pure model and the shell cannot diverge.
  """
  @spec committed(t(), reference()) :: {:ok, Batch.t(), t()} | {:error, term()}
  def committed(%__MODULE__{} = state, ref) do
    update(state, ref, [:committing], :committed, & &1, :release_ids)
  end

  @doc "Marks a committed batch as being applied and notified."
  @spec applying(t(), reference()) :: {:ok, Batch.t(), t()} | {:error, term()}
  def applying(%__MODULE__{} = state, ref) do
    update(state, ref, [:committed], :applying, & &1)
  end

  @doc """
  Marks an applied batch released and prunes it from the pipeline.

  Released is terminal and order-safe: the next claimed range becomes the
  head of `claim_order`.
  """
  @spec release(t(), reference()) :: {:ok, Batch.t(), t()} | {:error, term()}
  def release(%__MODULE__{} = state, ref) do
    case update(state, ref, [:applying], :released, & &1) do
      {:ok, batch, state} -> {:ok, batch, prune(state, ref)}
      error -> error
    end
  end

  @doc """
  Abandons a batch and prunes it from the pipeline.

  Valid before the durable mark: `:claimed`, `:prepared`, `:committing`, or
  `:committed`. Abandoning a `:committed` batch is the post-ack pre-apply
  failure path; the batch is already durable but its range still has to be
  resolved and its provisional marks cleared. Releasing the ids is
  idempotent, so the shell may have released them already on the commit ack.
  """
  @spec abandon(t(), reference(), term()) :: {:ok, Batch.t(), t()} | {:error, term()}
  def abandon(%__MODULE__{} = state, ref, reason) do
    case update(
           state,
           ref,
           [:claimed, :prepared, :committing, :committed],
           :abandoned,
           fn batch ->
             %{batch | reason: reason}
           end,
           :release_ids
         ) do
      {:ok, batch, state} -> {:ok, batch, prune(state, ref)}
      error -> error
    end
  end

  @doc """
  Returns the committed batches that may be applied next, in claim order.

  Stops at the first batch that is still committing or already applying, so
  a later durable range never overtakes an earlier one. Abandoned ranges
  were pruned when they were abandoned, so they do not block the buffer.
  This is the release decision #534's apply/notify stage consumes.
  """
  @spec releasable(t()) :: [Batch.t()]
  def releasable(%__MODULE__{} = state) do
    state.claim_order
    |> Enum.map(&Map.fetch!(state.batches, &1))
    |> Enum.take_while(&(&1.phase == :committed))
  end

  @doc """
  Reports the phase of the oldest open batch, or `:idle` when the pipeline
  has no claim.

  The pipeline can hold several batches in V2; the oldest one is the range
  that gates release and is therefore the one that defines the pipeline's
  observable phase.
  """
  @spec phase(t()) :: phase()
  def phase(%__MODULE__{claim_order: []}), do: :idle

  def phase(%__MODULE__{claim_order: [ref | _]} = state) do
    state.batches |> Map.fetch!(ref) |> Map.fetch!(:phase)
  end

  @spec get(t(), reference()) :: Batch.t() | nil
  def get(%__MODULE__{} = state, ref), do: Map.get(state.batches, ref)

  @doc "True when `ref` is waiting for a Committer result."
  @spec committing?(t(), reference()) :: boolean()
  def committing?(%__MODULE__{} = state, ref) do
    match?(%Batch{phase: :committing}, get(state, ref))
  end

  @doc """
  True while the pipeline holds any batch, including one applying or waiting
  in the release buffer.

  The shell asks `at_capacity?/1` when deciding whether to claim; this
  predicate remains the convenient "anything open?" check for callers and
  tests.
  """
  @spec inflight?(t()) :: boolean()
  def inflight?(%__MODULE__{} = state), do: inflight_count(state) > 0

  @doc """
  True when the pipeline holds as many batches as the configured depth.

  The shell uses this to decide whether a new claim may start. At the V0
  depth of one it is equivalent to `inflight?/1`, but a test or a later V2
  configuration can allow several ranges to commit at once without changing
  the scheduling rule.
  """
  @spec at_capacity?(t()) :: boolean()
  def at_capacity?(%__MODULE__{} = state), do: inflight_count(state) >= state.max_in_flight

  defp inflight_count(%__MODULE__{} = state), do: map_size(state.batches)

  defp update(state, ref, allowed_from, to, transform, action \\ :none) do
    case Map.fetch(state.batches, ref) do
      {:ok, %Batch{phase: phase} = batch} ->
        if phase in allowed_from do
          batch = %{transform.(batch) | phase: to}

          state = %{
            state
            | batches: Map.put(state.batches, ref, batch),
              in_flight_ids: maybe_release_ids(state.in_flight_ids, batch, action)
          }

          {:ok, batch, state}
        else
          {:error, {:invalid_transition, phase, to}}
        end

      :error ->
        {:error, :unknown_batch}
    end
  end

  defp maybe_release_ids(ids, _batch, :none), do: ids

  defp maybe_release_ids(ids, batch, :release_ids) do
    MapSet.difference(ids, MapSet.new(batch.action_ids))
  end

  defp prune(state, ref) do
    %{
      state
      | batches: Map.delete(state.batches, ref),
        claim_order: List.delete(state.claim_order, ref)
    }
  end
end
