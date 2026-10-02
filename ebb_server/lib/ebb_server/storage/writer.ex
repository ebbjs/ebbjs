defmodule EbbServer.Storage.Writer do
  @moduledoc """
  The single serialization point for the storage layer: every committed
  Action goes through this GenServer and is durably written to RocksDB
  before its GSN is returned to the caller.

  ## Why a single Writer

  Two invariants must hold for the on-disk Action log:

  1. **GSNs are unique and gap-free.** The catch-up endpoint answers
     "give me Actions from GSN > cursor", and an unbounded GSN gap would
     require O(n) latency. A single Writer is the simplest way to enforce
     this — GSN ranges are claimed atomically from `GSNCounter` via
     `:atomics`, but the final commit only happens here.
  2. **Per-Writer GSN-monotonicity.** Multi-Writer pipelining is possible
     (the benchmark hit ~108k/s — see #130) but requires committed-watermark
     and ordered fan-out coordination not yet built. We keep one Writer in
     production; the architecture supports more.

  ## Hot path

  `write_actions/2` claims a GSN range, runs permission validation,
  resolves FieldValue-wrapped data, builds the `cf_group_actions` index
  via intra-action context (see below), assembles the WriteBatch, commits
  with `sync: true`, advances the watermark, marks entities dirty, and
  notifies `FanOutRouter`. The notification carries the per-Action
  group set this pass resolved, so live fan-out indexes the same
  snapshot `cf_group_actions` was built from rather than re-deriving
  groups after the system caches have moved. If anything fails, no GSNs
  are returned to the caller.

  ## cf_group_actions index and intra-action context

  When building the `cf_group_actions` index entry for an update, the
  Writer resolves the group **set** the update belongs to. This is
  straightforward when the entity already exists — look it up in
  `RelationshipCache`. When the membership edge is being created in the
  same action (e.g. a "create todo" update paired with a
  `kind: "member"` relationship update), the cache has no entry yet.

  To handle that, the Writer builds an **intra-action context** before
  processing updates: it maps each `source_id` to the group ids carried
  by its `kind: "member"` relationship updates. `EntityIndex` unions
  that with the cached membership set, so an update is indexed once per
  group in the set.

  Example: an action with two updates:
  1. Create entity `todo_123` inside group `g_1` and `g_2`
  2. Add membership edges `rel_a` (`todo_123` → `g_1`) and `rel_b`
     (`todo_123` → `g_2`), both `kind: "member"`

  The intra-action context becomes
  `%{"todo_123" => ["g_1", "g_2"]}`. The Writer indexes the create
  and both edges into `g_1` and `g_2`. Domain links (`kind: "link"`,
  or no kind) do not move an entity between groups.
  """

  use GenServer

  alias EbbServer.Storage.PermissionChecker
  alias EbbServer.Storage.PermissionHelper
  alias EbbServer.Storage.WatermarkTracker

  alias EbbServer.Storage.{
    CacheTables,
    DirtyTracker,
    EntityIndex,
    Fields,
    GroupCache,
    GsnCounter,
    RelationshipCache,
    RocksDB
  }

  @type validated_action :: PermissionChecker.validated_action()
  @type validated_update :: PermissionChecker.validated_update()

  @type t :: %__MODULE__{
          rocks_name: GenServer.name(),
          dirty_set: atom(),
          gsn_counter: :atomics.atomics(),
          group_members: atom(),
          group_members_by_id: atom(),
          relationships: atom(),
          relationships_by_group: atom(),
          relationships_by_id: atom(),
          fan_out_router: GenServer.name(),
          watermark_tracker: GenServer.name()
        }
  defstruct [
    :rocks_name,
    :dirty_set,
    :gsn_counter,
    :group_members,
    :group_members_by_id,
    :relationships,
    :relationships_by_group,
    :relationships_by_id,
    :fan_out_router,
    :watermark_tracker
  ]

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, opts, name: name)
  end

  @type rejected_action :: %{action: validated_action(), reason: String.t()}
  @type write_result :: {:ok, {pos_integer(), pos_integer()}, [rejected_action()]}

  @spec write_actions([validated_action()], GenServer.name()) :: write_result() | {:error, term()}
  def write_actions(actions, name \\ __MODULE__) do
    GenServer.call(name, {:write_actions, actions})
  end

  @impl true
  @spec init(keyword()) :: {:ok, t()}
  def init(opts) do
    rocks_name = Keyword.get(opts, :rocks_name, EbbServer.Storage.RocksDB)

    dirty_set =
      Keyword.get(
        opts,
        :dirty_set,
        :persistent_term.get({DirtyTracker, :dirty_set}, :ebb_dirty_set)
      )

    gsn_counter = Keyword.get(opts, :gsn_counter, GsnCounter.get_resources().gsn_counter)

    group_members =
      Keyword.get(
        opts,
        :group_members,
        CacheTables.group_members()
      )

    group_members_by_id =
      Keyword.get(opts, :group_members_by_id) ||
        raise ArgumentError,
              "#{__MODULE__}.init/1 requires :group_members_by_id (pass it from the supervisor that owns the cache — see Sync.Supervisor for the boot wiring)"

    relationships =
      Keyword.get(
        opts,
        :relationships,
        CacheTables.relationships()
      )

    relationships_by_group =
      Keyword.get(
        opts,
        :relationships_by_group,
        CacheTables.relationships_by_group()
      )

    relationships_by_id =
      Keyword.get(opts, :relationships_by_id) ||
        raise ArgumentError,
              "#{__MODULE__}.init/1 requires :relationships_by_id (pass it from the supervisor that owns the cache — see Sync.Supervisor for the boot wiring)"

    fan_out_router = Keyword.get(opts, :fan_out_router, nil)
    watermark_tracker = Keyword.get(opts, :watermark_tracker, nil)

    {:ok,
     %__MODULE__{
       rocks_name: rocks_name,
       dirty_set: dirty_set,
       gsn_counter: gsn_counter,
       group_members: group_members,
       group_members_by_id: group_members_by_id,
       relationships: relationships,
       relationships_by_group: relationships_by_group,
       relationships_by_id: relationships_by_id,
       fan_out_router: fan_out_router,
       watermark_tracker: watermark_tracker
     }}
  end

  @doc """
  Validates, assigns GSNs, and persists actions to RocksDB.

  Actions are already validated by PermissionChecker before reaching the Writer.
  Pipeline:
  1. Filter out actions with empty updates (safety check)
  2. Claim a GSN range from GsnCounter for the batch
  3. Build a batch of puts across all 6 column families:
     - cf_actions: GSN → full action (ETF encoded)
     - cf_action_dedup: action_id → GSN (duplicate detection)
     - cf_updates: (action_id, update_id) → update (ETF encoded)
     - cf_entity_actions: (subject_id, GSN) → action_id (materialization index)
     - cf_type_entities: (subject_type, subject_id) → <<>> (type index)
     - cf_group_actions: (group_id, GSN) → action_id (group catch-up index)
  4. Write batch synchronously to RocksDB
  5. Mark affected entities dirty in DirtyTracker

  Returns `{:ok, {gsn_start, gsn_end}, rejected_actions}` on success.
  """
  @impl true
  def handle_call({:write_actions, actions}, _from, state) when is_list(actions) do
    filtered = Enum.reject(actions, &(&1.updates == []))

    if filtered == [] do
      {:reply, {:ok, {0, 0}, []}, state}
    else
      batch_size = length(filtered)

      {gsn_start, gsn_end} = GsnCounter.claim_gsn_range(batch_size, state.gsn_counter)

      rocks_name = state.rocks_name

      {ops, groups_by_gsn} =
        filtered
        |> Enum.with_index(gsn_start)
        |> Enum.map_reduce(%{}, fn {action, gsn}, acc ->
          {action_ops, group_ids} =
            build_action_ops(
              action,
              gsn,
              rocks_name,
              state.relationships,
              state.relationships_by_id,
              state.group_members_by_id
            )

          {action_ops, Map.put(acc, gsn, group_ids)}
        end)

      write_and_respond(
        List.flatten(ops),
        filtered,
        gsn_start,
        gsn_end,
        groups_by_gsn,
        state,
        rocks_name
      )
    end
  end

  defp write_and_respond(ops, filtered, gsn_start, gsn_end, groups_by_gsn, state, rocks_name) do
    case RocksDB.write_batch(ops, name: rocks_name) do
      :ok ->
        entity_ids =
          filtered
          |> Enum.flat_map(fn action -> action.updates end)
          |> Enum.map(fn update -> update.subject_id end)
          |> Enum.uniq()

        :ok = DirtyTracker.mark_dirty_batch(entity_ids, state.dirty_set)
        update_system_caches(filtered, state)

        if state.watermark_tracker do
          :ok = WatermarkTracker.mark_range_committed(gsn_start, gsn_end, state.watermark_tracker)
          WatermarkTracker.advance_watermark(state.watermark_tracker)
        end

        if state.fan_out_router && Process.whereis(state.fan_out_router) do
          send(state.fan_out_router, {:batch_committed, gsn_start, gsn_end, groups_by_gsn})
        end

        {:reply, {:ok, {gsn_start, gsn_end}, []}, state}

      {:error, reason} ->
        {:reply, {:error, {:rocksdb_write_failed, reason}}, state}
    end
  end

  defp update_system_caches(actions, state) do
    for action <- actions,
        update <- action.updates,
        update.subject_type in ["groupMember", "relationship"] do
      case update.subject_type do
        "groupMember" -> handle_group_member_update(update, state)
        "relationship" -> handle_relationship_update(update, state)
      end
    end
  end

  defp handle_group_member_update(update, state) do
    case update.method do
      method when method in [:put, :patch] ->
        data = update.data || %{}

        actor_id = Fields.get(data, "actor_id")
        group_id = Fields.get(data, "group_id")
        permissions = Fields.get(data, "permissions")

        GroupCache.put_group_member(
          %{
            id: update.subject_id,
            actor_id: actor_id,
            group_id: group_id,
            permissions: permissions
          },
          state.group_members
        )

      :delete ->
        GroupCache.delete_group_member(update.subject_id, state.group_members)
    end
  end

  defp handle_relationship_update(update, state) do
    case update.method do
      method when method in [:put, :patch] ->
        data = update.data || %{}

        source_id = Fields.get(data, "source_id")
        target_id = Fields.get(data, "target_id")
        type = Fields.get(data, "type")
        field = Fields.get(data, "field")
        kind = Fields.get(data, "kind")

        RelationshipCache.put_relationship(
          %{
            id: update.subject_id,
            source_id: source_id,
            target_id: target_id,
            type: type,
            field: field,
            kind: kind
          },
          relationships: state.relationships,
          relationships_by_group: state.relationships_by_group,
          relationships_by_id: state.relationships_by_id
        )

      :delete ->
        RelationshipCache.delete_relationship(
          update.subject_id,
          relationships: state.relationships,
          relationships_by_group: state.relationships_by_group,
          relationships_by_id: state.relationships_by_id
        )
    end
  end

  defp build_action_ops(
         action,
         gsn,
         rocks_name,
         relationships,
         relationships_by_id,
         group_members_by_id
       ) do
    action_with_gsn = to_storage_format(action, gsn)
    action_etf = :erlang.term_to_binary(action_with_gsn)

    intra_ctx = build_intra_action_context(action.updates)

    {update_ops, group_ids_by_update} =
      Enum.map_reduce(action.updates, [], fn update, acc ->
        {ops, group_ids} =
          build_update_ops(
            action.id,
            update,
            gsn,
            rocks_name,
            relationships,
            relationships_by_id,
            group_members_by_id,
            intra_ctx
          )

        {ops, [group_ids | acc]}
      end)

    group_ids =
      group_ids_by_update
      |> Enum.reverse()
      |> List.flatten()
      |> Enum.uniq()

    ops =
      [
        {:put, RocksDB.cf_actions(rocks_name), RocksDB.encode_gsn_key(gsn), action_etf},
        {:put, RocksDB.cf_action_dedup(rocks_name), action.id, RocksDB.encode_gsn_key(gsn)}
      ] ++ List.flatten(update_ops)

    {ops, group_ids}
  end

  defp build_intra_action_context(updates) do
    PermissionHelper.build_intra_action_context(updates)
  end

  defp to_storage_format(action, gsn) do
    %{
      "id" => action.id,
      "actor_id" => action.actor_id,
      "hlc" => action.hlc,
      "gsn" => gsn,
      "updates" =>
        Enum.map(action.updates, fn update ->
          method_str =
            if is_atom(update.method), do: Atom.to_string(update.method), else: update.method

          %{
            "id" => update.id,
            "subject_id" => update.subject_id,
            "subject_type" => update.subject_type,
            "method" => method_str,
            "data" => update.data
          }
        end)
    }
  end

  defp build_update_ops(
         action_id,
         update,
         gsn,
         rocks_name,
         relationships,
         relationships_by_id,
         group_members_by_id,
         intra_ctx
       ) do
    update_etf = :erlang.term_to_binary(update)

    group_ids =
      group_ids_for_update(
        update,
        relationships,
        relationships_by_id,
        group_members_by_id,
        intra_ctx
      )

    index_ops =
      Enum.map(group_ids, fn group_id ->
        key = <<group_id::binary, gsn::unsigned-big-integer-size(64)>>
        {:put, RocksDB.cf_group_actions(rocks_name), key, action_id}
      end)

    ops =
      [
        {:put, RocksDB.cf_updates(rocks_name), RocksDB.encode_update_key(action_id, update.id),
         update_etf},
        {:put, RocksDB.cf_entity_actions(rocks_name),
         RocksDB.encode_entity_gsn_key(update.subject_id, gsn), action_id},
        {:put, RocksDB.cf_type_entities(rocks_name),
         RocksDB.encode_type_entity_key(
           update.subject_type,
           update.subject_id
         ), <<>>}
      ] ++ index_ops

    {ops, group_ids}
  end

  defp group_ids_for_update(
         _update,
         nil,
         _relationships_by_id,
         _group_members_by_id,
         _intra_ctx
       ),
       do: []

  defp group_ids_for_update(
         update,
         relationships,
         relationships_by_id,
         group_members_by_id,
         intra_ctx
       ) do
    opts = [
      relationships: relationships,
      relationships_by_id: relationships_by_id,
      group_members_by_id: group_members_by_id,
      intra_action: intra_ctx
    ]

    case update.subject_type do
      "relationship" ->
        EntityIndex.relationship_groups(
          Fields.get(update.data, "source_id"),
          update.subject_id,
          opts
        )

      type ->
        EntityIndex.resolve_groups(type, update.subject_id, opts)
    end
  end
end
