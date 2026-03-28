# Permission Checker

## Purpose

Validates incoming Actions before they reach the Writer. Enforces structural correctness, HLC drift limits, actor identity, and Group-based authorization. All permission lookups use ETS (sub-microsecond) -- no database reads on the permission check path.

## Responsibilities

- Validate Action structure (required fields, valid IDs, valid methods)
- Validate actor identity (Action's `actor_id` matches authenticated actor)
- Validate HLC:
  - Reject if logical time (`hlc >> 16`) > server's wall clock + 120 seconds (future drift)
  - Reject if logical time (`hlc >> 16`) < server's wall clock - 24 hours (stale / broken client clock)
  - Reject if HLC is not a non-negative integer
- Authorize each Update against the actor's Group memberships and entity Relationships
- Handle intra-Action resolution (new entity + Relationship in the same Action)
- Handle Group bootstrap (unpermissioned: Group + GroupMember + Relationship in one Action)
- Return per-Action accept/reject decisions with reasons

## Public Interface

### Module: `EbbServer.Storage.PermissionChecker`

This is a stateless module (no GenServer). All state comes from ETS lookups.

#### Validation API

| Name                       | Signature                                                                                                                                    | Description                                                                                                               |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `validate_and_authorize/2` | `validate_and_authorize(actions :: [raw_action()], actor_id :: String.t()) :: {accepted :: [validated_action()], rejected :: [rejection()]}` | Validates structure, checks permissions, returns accepted Actions (ready for Writer) and rejected Actions (with reasons). |

#### Individual Checks (composable, testable)

| Name                   | Signature                                                                                          | Description                                                                                                                                                                                        |
| ---------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `validate_structure/1` | `validate_structure(action :: raw_action()) :: :ok \| {:error, String.t()}`                        | Checks required fields, ID formats, valid methods, non-empty updates list.                                                                                                                         |
| `validate_actor/2`     | `validate_actor(action :: raw_action(), actor_id :: String.t()) :: :ok \| {:error, String.t()}`    | Checks `action.actor_id == actor_id`.                                                                                                                                                              |
| `validate_hlc/1`       | `validate_hlc(action :: raw_action()) :: :ok \| {:error, String.t()}`                              | Checks HLC is not too far in the future (120s drift limit) or too far in the past (24h staleness limit). Also validates the HLC is a valid 64-bit integer with a plausible logical time component. |
| `authorize_updates/2`  | `authorize_updates(action :: raw_action(), actor_id :: String.t()) :: :ok \| {:error, String.t()}` | Checks each Update against Group membership + Relationship permissions.                                                                                                                            |

### Types

```elixir
@type raw_action :: %{
  "id" => String.t(),
  "actor_id" => String.t(),
  "hlc" => non_neg_integer(),
  "updates" => [raw_update()]
}

@type raw_update :: %{
  "id" => String.t(),
  "subject_id" => String.t(),
  "subject_type" => String.t(),
  "method" => String.t(),       # "PUT" | "PATCH" | "DELETE"
  "data" => map() | nil
}

@type validated_action :: %{
  id: String.t(),
  actor_id: String.t(),
  hlc: non_neg_integer(),
  updates: [validated_update()]
}

@type validated_update :: %{
  id: String.t(),
  subject_id: String.t(),
  subject_type: String.t(),
  method: :put | :patch | :delete,
  data: map() | nil
}

@type rejection :: %{
  action_id: String.t(),
  reason: String.t(),
  details: String.t() | nil
}
```

## Dependencies

| Dependency   | What it needs                                                  | Reference                                        |
| ------------ | -------------------------------------------------------------- | ------------------------------------------------ |
| System Cache | `get_actor_groups/1` -- actor's Group memberships              | [system-cache.md](system-cache.md#group-members) |
| System Cache | `get_permissions/2` -- actor's permissions in a specific Group | [system-cache.md](system-cache.md#group-members) |
| System Cache | `get_entity_group/1` -- which Group an entity belongs to       | [system-cache.md](system-cache.md#relationships) |

## Internal Design Notes

**Authorization flow for each Update:**

```elixir
def authorize_update(update, actor_id, intra_action_context) do
  case update.subject_type do
    # System entity types have special rules
    "group" -> authorize_group_update(update, actor_id, intra_action_context)
    "groupMember" -> authorize_group_member_update(update, actor_id, intra_action_context)
    "relationship" -> authorize_relationship_update(update, actor_id, intra_action_context)

    # User entity types: check Group membership + permissions
    type -> authorize_user_entity_update(update, actor_id, type, intra_action_context)
  end
end
```

**User entity authorization:**

```elixir
def authorize_user_entity_update(update, actor_id, type, intra_action_ctx) do
  # 1. Find the entity's Group
  group_id = case SystemCache.get_entity_group(update.subject_id) do
    nil ->
      # Entity not in cache -- check intra-Action context for a Relationship
      # being created in the same Action
      find_intra_action_relationship(update.subject_id, intra_action_ctx)
    group_id -> group_id
  end

  # 2. Check actor is a member of that Group
  case SystemCache.get_permissions(actor_id, group_id) do
    nil -> {:error, "not_authorized", "actor not a member of entity's group"}
    :wildcard -> :ok
    permissions ->
      # 3. Check specific permission (e.g., "todo.update")
      required = "#{type}.#{method_to_permission(update.method)}"
      if required in permissions or "#{type}.*" in permissions do
        :ok
      else
        {:error, "not_authorized", "missing permission: #{required}"}
      end
  end
end
```

**Intra-Action resolution:** When an Action creates a new entity AND its Relationship in the same Action, the entity won't be in the ETS cache yet. The Permission Checker builds an `intra_action_context` by scanning all Updates in the Action before checking permissions:

```elixir
def build_intra_action_context(updates) do
  # Extract Relationships being created in this Action
  updates
  |> Enum.filter(fn u -> u["subject_type"] == "relationship" and u["method"] == "PUT" end)
  |> Enum.map(fn u -> {u["data"]["source_id"], u["data"]["target_id"]} end)
  |> Map.new()
  # Returns %{entity_id => group_id} for entities being related in this Action
end
```

**Group bootstrap (unpermissioned):** A single Action that creates a Group + GroupMember + Relationship is the bootstrap pattern. The Permission Checker detects this pattern:

1. Action contains a PUT for a `group` entity
2. Action contains a PUT for a `groupMember` entity where `group_id` matches the new Group and `actor_id` matches the authenticated actor
3. Action contains a PUT for a `relationship` entity linking to the new Group

If all three are present and the actor is creating their own membership, the entire Action is allowed without further permission checks.

**Validation to domain type conversion:** `validate_and_authorize/2` converts `raw_action` (string keys, string methods from MessagePack decode) to `validated_action` (atom keys, atom methods) as part of validation. This ensures the Writer receives clean, typed data.

## Open Questions

- **Permission granularity:** The spec shows permissions as `["post.create", "post.update"]` or `"*"` (wildcard). Should there be a `"*.create"` pattern (create any type)? The current design supports exact match and type wildcard (`"todo.*"`). Cross-type wildcards can be added later.
- **Rate limiting:** Should the Permission Checker enforce per-actor rate limits? The spec doesn't mention rate limiting. This could be added as a separate middleware in the HTTP API layer rather than in the Permission Checker.
- **Tombstone handling for permissions:** When a GroupMember is deleted (revocation), the ETS cache removes the entry. But what about in-flight Actions that were authorized before the revocation? Since Writers process Actions sequentially within each GenServer, and system entity cache updates happen inline (before replying), there's a small window where an Action authorized by Writer 1 could be committed after Writer 2 processes a revocation. This is acceptable -- the revocation takes effect for all subsequent Actions.
