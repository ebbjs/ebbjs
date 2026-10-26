# ebb

A local-first backend framework. Each client keeps a **replica** of the data it
is subscribed to, materialized locally so reads are immediate and work offline,
and converges with the server and other clients by merging actions.

## Language

### Replication

**Replica**:
A client's local copy of the groups it is subscribed to. It owns the action log
(the history) and the materialized entities (the current state).
_Avoid_: read model, store, cache, local database

**Action**:
A batch of Updates submitted as one unit; the unit of sync, permission, and
delivery.
_Avoid_: mutation, change set, transaction

**Update**:
One write to one entity, carrying an HLC and an update id.
_Avoid_: change, event, op

**Action log**:
The replica's append-only history of Actions.
_Avoid_: journal, change feed, write-ahead log

**Materialize**:
Derive an entity's current row from the Action log under the merge rule.
_Avoid_: hydrate, project, build, denormalize

**Revision**:
The replica's monotonic counter, advanced only when materialization changes
observable state.
_Avoid_: version, watermark, snapshot version

**Cursor**:
The per-group position in the Action stream the replica has caught up to.
_Avoid_: offset, checkpoint

**Backfill**:
Fetch entities a replica is missing, e.g. after joining a group.
_Avoid_: sync, catch-up, hydrate

**Catch-up**:
Resume the Action stream from the replica's cursor after being offline.
_Avoid_: backfill, sync

**Outbox**:
The replica's local Actions not yet accepted by the server.
_Avoid_: queue, pending writes

**Conflict**:
Two Updates to a field that the merge rule cannot order without losing one.
_Avoid_: collision, clash

### Materialization

**Held**:
An entity type the replica always materializes.
_Avoid_: resident, pinned, eager, tiered

**On demand**:
An entity type the replica materializes only once it is opened.
_Avoid_: windowed, lazy, cold

**Open** / **Close**:
Bring a document's content into the replica / release it from memory.
_Avoid_: load, fetch, hydrate, evict, window

### Queries

**Query**:
A read request over the replica. A `QueryBuilder` builds one; the engine runs
it.
_Avoid_: query token, query spec, query plan

**Result status**:
Whether a Query's result reflects the replica's current revision — _unloaded_
(never run), _stale_ (run at an older revision), _current_ (run at the replica's
revision), _failed_.
_Avoid_: loading, cached, complete, error

### Schema

**Entity**:
A row of one type, identified by an id, whose fields are merged independently.
_Avoid_: document, record, object

**Committed type**:
The type an entity id is known by, set by its first write; a write's declared
`subject_type` must equal it.
_Avoid_: wire type, declared type, relabel, retype

**Field**:
A named value on an entity; either a leaf or a map of leaves.
_Avoid_: column, property, attribute

**Relationship**:
A named, typed link from a source entity to a target entity.
_Avoid_: edge, reference, foreign key

**Membership**:
The row scoping an entity to a group.
_Avoid_: scope, acl

**Group**:
The unit of permission and delivery; every entity belongs to at least one.
_Avoid_: workspace, tenant, room
