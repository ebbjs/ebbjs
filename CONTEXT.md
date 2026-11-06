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

### Presence

**Presence**:
Ephemeral state an actor broadcasts about where it is or what it is doing on an
entity. Never durable, never in the Action log, and lossy on disconnect — the
one primitive outside the replication contract.
_Avoid_: cursor state, awareness, ephemeral data

**Presence channel**:
A named, declared slice of an entity's presence — `cursor`, `camera`, `tool` —
with its own value schema, send debounce, receive TTL, and entry cap.
_Avoid_: topic, room, stream, event type

**Peer**:
Another actor observed on a presence channel of an entity: the payload that
actor last sent plus the local time it arrived.
_Avoid_: remote user, collaborator, participant, viewer

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

**App**:
A deployed client of the shared store — `notes`, `issues` — named by the
`appId` passed to `createClient`. Its browser origins are registered
server-side in the app registry (`/admin/apps`, `<data_dir>/apps.json`), and
registration admits those origins to CORS only. Not a tenant, not a credential,
and not an actor for non-browser callers; Groups remain the unit of permission.
_Avoid_: tenant, client identity, origin, service

**App scope**:
The groups an app pulls into its replica, declared per group as `group.apps`.
A sync/residency filter, not an authorization boundary; absent scope means
every app. Separate from origin registration, which only admits browser origins
to CORS.
_Avoid_: permission, ACL, access, filter

### Functions

**Function**:
A named, deployed handler invoked over `POST /functions/:name`, authored with
`defineFunction` and granted by `function.<name>`.
_Avoid_: endpoint, lambda, RPC method

**Invocation**:
One run of a Function for one Subject, committing at most one Action.
_Avoid_: call, request, execution

**Subject**:
The actor an Invocation runs as, whose grants decide whether it may invoke and
what it may read and write.
_Avoid_: caller, user, principal

**Bundle**:
The esbuild output plus the envelope — name, version, digest, entry, RPC
schemas — that names one deployable Function version.
_Avoid_: artifact, package, script

**Runner**:
The Bun process that evaluates a Bundle and runs one Invocation against the
host-call frame protocol.
_Avoid_: worker, sandbox, executor

**Worker**:
The server's transport to one Runner process: its socket, process group, and
deadline.
_Avoid_: runner, pool, sandbox
