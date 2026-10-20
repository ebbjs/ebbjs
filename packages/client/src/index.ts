/**
 * @ebbjs/client — local-first sync SDK for the ebb server.
 *
 * Slice 1 ships the **read path**:
 * - handshake, catch-up, subscribe (SSE), entity read / query, write.
 * - Connection state machine with reconnect backoff.
 * - Action receipt → in-memory storage adapter.
 *
 * Slice 2 adds field-type subscribers:
 * - `client.textDocument(docId)` opens a TextDocument (causal-tree field)
 *   with local edit API, onUpdate events, and pendingActions queue for
 *   `client.write()`.
 *
 * Slice 3 adds the bridge package `@ebbjs/codemirror` (peer dep) plus
 * presence (ephemeral cursors/selections).
 */

export {
  SyncClient,
  createClient,
  type HandshakeResult,
  type NamespacedClient,
  type QueryOptions,
  type ReplicaLoadReport,
  type SyncObservables,
} from "./sync/client";

export {
  AtomicActionError,
  AtomicResolutionError,
  type AtomicClient,
  type AtomicCreateInput,
  type AtomicCreateOptions,
  type AtomicDraftNamespace,
  type AtomicDrafts,
  type AtomicRejection,
  type AtomicSystemDraftNamespace,
  type CreatedEntity,
} from "./sync/atomic";

export {
  PermissionError,
  type PermissionViolation,
  type PermissionVerb,
  type PermissionQuery,
  type CanResult,
  type CanSubject,
  type CanUnknownReason,
} from "./sync/permission";

export {
  OnDemandQueryError,
  type QueryBuilder,
  type QueryContext,
  type ProjectedRow,
  type QueryRow,
  type PointerValue,
  type JoinRecord,
  type MembershipJoin,
  type JoinSelection,
  type JoinedRow,
  type NoJoins,
  projectEntity,
  projectRow,
  projectRows,
  projectQueryRow,
  buildQueryBuilder,
  buildLazyQueryBuilder,
  buildReplicaQueryBuilder,
  type LoadEntities,
} from "./sync/query-builder";

export {
  type Query,
  type Predicate,
  type QueryOrder,
  type Join,
  type JoinDirection,
  type JoinCardinality,
} from "./sync/query";

export { type Plan, type PlanOp, type PlanPredicate, planQuery } from "./sync/query-plan";

export {
  DEFAULT_QUERY_TTL_MS,
  type QueryCache,
  type QueryCacheOptions,
  type QueryResult,
  type QuerySource,
  type QueryStatus,
  type QueryStore,
  type QuerySubscribeOptions,
  type QuerySurface,
} from "./sync/query-cache";

export type { ReplicaSignal } from "./sync/replica-signal";
export type { ReplicaStats } from "@ebbjs/storage/replica";

export {
  type PlanExecutor,
  createReplicaExecutor,
  createRowsExecutor,
  executePlan,
} from "./sync/query-execute";

export { traversalCounter } from "./sync/traversal-counter";

export {
  type EntityNamespace,
  type EntityFields,
  type EntityNamespaces,
  type EntityRow,
  type EntitySnapshot,
  type EntityWithAccessors,
  type MembershipNamespace,
  type GroupNamespace,
  type MembershipAccessors,
  type QueryRoot,
  type RowAccessor,
  type CreateOptions,
  type CreateResult,
  type DuplicateAt,
  type DuplicateOptions,
  type EntityWriteOptions,
  type GroupRef,
  createEntityNamespace,
  buildEntityNamespaces,
  type ReplicaAccess,
} from "./sync/namespace";
export { PresenceManager, type PresenceEntry, type CursorPresence } from "./presence/presence";

export {
  ConnectionStateMachine,
  type ConnectionState,
  type StateChangeListener,
} from "./sync/connection-state";

export {
  type Outbox,
  type OutboxEntry,
  type ConflictedOutboxEntry,
  type OutboxStatus,
  type OutboxCounts,
  type OutboxChangeListener,
  type StoreFault,
  type StoreFaultListener,
  type FlushOutcome,
} from "./sync/outbox";

export {
  type OutboxObserver,
  type OutboxSnapshot,
  type OutboxSnapshotListener,
} from "./sync/outbox-observer";

export { type FlushScheduler, type FlushLatencyListener } from "./sync/flush-scheduler";

export {
  type Conflicts,
  type Conflict,
  type ConflictSlotView,
  type ConflictSubjectStateView,
  type EntityDiff,
  type ConflictResolution,
  type ConflictChangeListener,
  type ConflictSnapshot,
  type ResolveResult,
  type FailedResolution,
} from "./sync/conflicts";

export { type ReadonlyObservable } from "./sync/observable";

export { type ClientStatus } from "./sync/status";

export type { ConflictEntry } from "./sync/conflicts";
export type { ConflictSide, ConflictSlot } from "@ebbjs/storage/types";

export {
  openSSEStream,
  parseSSEBlock,
  type SSESubscription,
  type SSEOpenOptions,
} from "./sync/sse";

export {
  TextDocument,
  TextDocumentRegistry,
  type AppliedUpdate,
  type LocalInsertOptions,
  type LocalDeleteOptions,
  type LocalExtendOptions,
  type UpdateListener,
} from "./fields/collaborative-text/text-document";

export {
  applyActions,
  docActionToUpdate,
  diffRunFields,
  diffRunFieldsForDeleteRange,
  isDocSubjectUpdate,
  parseContentField,
  DEFAULT_DOC_SUBJECT_TYPE,
} from "./fields/collaborative-text/wire";

export {
  RunNodeSchema,
  DOC_CONTENT_FIELD,
  generatedDocEntityName,
} from "./fields/collaborative-text/schema";

export {
  createDocState,
  docReducer,
  reconstruct,
  findInsertPosition,
  lookupPosition,
  runOffsetToPosition,
  makeRunId,
  makeSplitId,
  parseRunId,
  compareRuns,
  ROOT_ID,
  type DocAction,
  type InsertRunAction,
  type DeleteRangeAction,
  type SplitAction,
  type ExtendRunAction,
  type DocState,
  type RunNode,
  type RunSpan,
  type PositionIndex,
  type PositionLookup,
} from "./fields/collaborative-text/tree";

export type {
  GroupInfo,
  HandshakeResponse,
  HandshakeRequest,
  CatchUpResponse,
  WriteResponse,
  Rejection,
  EntityResponse,
  EntityQueryResponse,
  GroupListingResponse,
  SSEEvent,
  ControlEvent,
  PresenceEvent,
  SyncClientOptions,
  RegistryViolationContext,
  RegistryViolationListener,
} from "./sync/types";

export {
  defineAction,
  ActionDefinitionError,
  type Action,
  type ActionDef,
  type ActionDefinitionViolation,
  type AnyActionDef,
} from "./schema/action";

export {
  defineEntity,
  e,
  type EntityDef,
  type EntityOptions,
  type FieldMarker,
  type ConflictScope,
  type Materialization,
  type NullableSchema,
  type MapSchema,
  type CollaborativeTextSchema,
  type CollaborativeTextOptions,
  type DerivedFieldDef,
  type DerivedAccessors,
  type DerivedKeys,
  type WireFields,
  type TSchema,
} from "./schema/entity";

export {
  defineRelationship,
  type RelationshipDef,
  type RelationshipKind,
  type SourceCardinality,
  type DefineRelationshipInput,
} from "./schema/relationship";

export {
  EntityRegistry,
  EntityValidationError,
  type ValidationViolation,
} from "./schema/entity-registry";

export {
  defineSchema,
  UnregisteredRelationshipEndpointError,
  DerivedFieldCollisionError,
  DerivedDocNameCollisionError,
  ConflictScopeMismatchError,
  type DefineSchemaInput,
  type ExpandedEntities,
  type Schema,
} from "./schema/schema";

export {
  ReservedNameError,
  RESERVED_ENTITY_NAMES,
  RESERVED_MEMBERSHIP_NAMES,
  DERIVED_DOC_ENTITY_PREFIX,
} from "./schema/reserved";

export {
  relationshipSystemEntity,
  groupSystemEntity,
  groupMemberSystemEntity,
  entityGroupSystemEntity,
  GROUPS_ACCESSOR,
  type GroupFields,
  type GroupMemberFields,
  type EntityGroupFields,
} from "./schema/system-entities";
