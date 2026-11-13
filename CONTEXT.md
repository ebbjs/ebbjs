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
One write to one component of one entity, carrying an HLC and an update id.
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

**Leave**:
Retract the presence this session announced: send a `null` for each claimed
`(entity, channel)`, so peers drop the actor now instead of aging it out on the
channel TTL. The app calls it when the actor is really gone; `client.close()`
is local teardown and never leaves.
_Avoid_: unload, broadcast absence, release

### Components

**Component**:
A named value attached to an entity, together with the policy that applies to
it: existence, loading, conflict scope, indexing, version. Declared with
`defineComponent`; a bare field builder declares one anonymously.
_Avoid_: field, attribute, property, column

**Leaf**:
The merge position: a `{value, update_id, hlc}` envelope, or a map of them keyed
by entry id. Merging happens at leaves and nowhere else.
_Avoid_: cell, slot, atom

**Atomic component**:
A component whose value is one merge position, so a concurrent write replaces
the record whole and its fields cannot tear apart.
_Avoid_: object, struct, record

**Keyed component**:
A component whose value is a key space, so each field holds its own merge
position and a concurrent write to one leaves its siblings alone. An append-only
component (`e.log`) is a keyed component that refuses rewrites.
_Avoid_: map, sparse, table

**Anonymous component**:
The component a bare field builder declares — one leaf, held, model-scoped
conflict, version 1. Every field declared before components existed is one.
_Avoid_: plain field, implicit component

**Model**:
The declared component set `defineModel` names, and the unit of permission,
query source, and projection. Which of its components an entity carries is
dynamic; which of them it _may_ carry is fixed by the model. An entity carries
components of exactly one _user_ model: for a user component the model is the
namespace, not a tag. `ebb/*` components are the platform's overlay and may sit
on any row without re-modelling it.
_Avoid_: entity, type, class, table, collection

**Archetype**:
The component set an entity actually carries, as against its model's declared
set. One model's entities occupy one archetype per subset of present
components.
_Avoid_: shape, type

**Existence index**:
The component-keyed index answering "which entities carry this component" —
derived ETS state on the server (rebuilt from `cf_actions` on boot, not a
column family), and `componentIndex` in the replica. The replica also keeps a
**model index** (model → ids) for `query()`, and an optional **archetype
index** (component set → ids) to skip intersecting.
_Avoid_: type index, presence index

**Existence**:
Whether an entity carries a component. Distinct from a leaf's value: a present
leaf holding a tombstone still exists, and an absent component has no value at
all. Never the ephemeral Presence primitive.
_Avoid_: presence, attachment, membership

**Row existence**:
Whether an id's row is committed and not tombstoned, independent of how many
components it carries. A row with zero components exists; only `delete` removes
it. Distinct from _Existence_ (component presence) and from _Materialize_ (a
tombstoned row can be materialized in a cache and still not exist).
_Avoid_: create bit, row presence

**Placeholder**:
A replica row materialized from a component write whose create it has not seen.
Its `exists` bit is false, so content backfill fetches the base; the server's
row itself exists. Distinct from _Row existence_, which the server answers.
_Avoid_: partial row, stub, pending entity

**Tombstone**:
A present leaf whose `value` is `null`: it records that the position was cleared
and keeps an HLC so a later write can still win. A tombstone is a value, not an
absence.
_Avoid_: null, deletion, empty

**Loading**:
The policy a component declares for materialization: _eager_ keeps it held;
_lazy_ materializes it only once it is opened. Declared per component. Distinct
from _Residency_, the state that policy produces.
_Avoid_: materialization, cache policy, load strategy

**Residency**:
The state a component's _Loading_ policy produces: held, or on demand until
opened. Distinct from the declaration. See _Held_ and _On demand_.
_Avoid_: tier, cache policy, eviction policy

**Conflict scope**:
The granularity at which a concurrent write is surfaced as a conflict: _field_,
_component_, or _entity_. Declared per component. A field- or component-scope
conflict holds the contested component; an entity-scope conflict holds every
pending write to the row. A _structural_ component opts out of detection
entirely rather than declaring a scope.
_Avoid_: conflict level, conflict granularity

**Project**:
Derive the value a reader sees from a component's stored leaves — resolve
declared defaults, hide tombstones. An `optional` component declares no default,
so absence and a cleared leaf both project as `undefined`; only a present value
projects as a value. Distinct from _Materialize_, which derives a row from the
Action log.
_Avoid_: hydrate, denormalize, resolve

**System component**:
A component in the `ebb/` namespace the platform owns and interprets:
`ebb/group`, `ebb/grant`, `ebb/membership`, `ebb/link`. Each is atomic,
structural (never surfaced as a conflict), declares a scope owner, and carries
its own permission.
_Avoid_: system entity type, built-in type

**Scope owner**:
The entity whose group set a component's write is authorized and delivered
against: the entity itself, an entity one of its values names, or the entity
carrying it. Declared per component, and only in the `ebb/` namespace.
_Avoid_: fan-out target, ACL subject

**Grant**:
An `ebb/grant` row giving one actor permissions in one group.
_Avoid_: membership, role, permission row

**Archive component**:
A declared component holding superseded values — a document body kept at an
older codec — so an upgrade needs no new entity id.
_Avoid_: history, backup, version

### Systems

**System**:
A deterministic fold or predicate over the Action log: a _predicate_ on the
write path (validate, scope, authorize) or a _projection_ off the committed log
(index, cache, read model). Never a scheduler, and never a mutation — only an
Action changes state.
_Avoid_: handler, service, processor, job

### Materialization

**Held**:
A component the replica always materializes.
_Avoid_: resident, pinned, tiered

**On demand**:
A component the replica materializes only once it is opened.
_Avoid_: windowed, cold

**Open** / **Close**:
Bring an on-demand component's value into the replica / release it from memory.
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

**Keyset pagination**:
Resuming a listing from the last row's sort key rather than from an offset, so a
row committed mid-page cannot shift the window. A listing that paginates needs
ordered rows, not a key set.
_Avoid_: offset pagination, cursor

### Schema

**Entity**:
An identified thing in the store, holding a set of components that merge
independently. Its model fixes which components it may carry; which ones it
does carry is its archetype.
_Avoid_: document, object, model

**Row**:
The stored form of an entity: its id, the components it carries, and its
lifecycle stamps. Say _entity_ about the domain, _row_ about storage.
_Avoid_: record, document

**Committed model**:
The model an entity id is known by, set by its first write. Every later write
must name a component that model declares, so an id cannot be re-filed under
another model's permissions.
_Avoid_: wire type, declared type, committed type, relabel, retype

**Field**:
A named position inside a component's value. Fields are not addressed on the
wire; the component is.
_Avoid_: column, property, attribute

**Position path**:
The sequence of field names naming one leaf inside a component — `updates`, or
`runs.abc.text`. Guards and conflict slots name a path, never a bare field name.
_Avoid_: key path, pointer

**Relationship**:
A named, typed link from a source entity to a target entity.
_Avoid_: edge, reference, foreign key

**Membership**:
The row scoping an entity to a group. One row per `(entity, group)`, and the pair
is immutable after create; groups and grants carry none.
_Avoid_: scope, acl

**Group**:
The unit of permission and delivery; every entity belongs to at least one. A
group's scope is itself, so it carries no membership row.
_Avoid_: workspace, tenant, room

**App**:
A deployed client of the shared store — `notes`, `issues` — with an entry in
the server's app registry (`/admin/apps`, `<data_dir>/apps.json`): an
operator-facing `name`, a server-minted `id`, and the browser origins it admits
to CORS. Registration admits origins only. Not a tenant, not a credential, and
not an actor for non-browser callers; Groups remain the unit of permission.
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
