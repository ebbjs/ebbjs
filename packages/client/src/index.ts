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
  IdentityResolutionError,
  resolveIdentity,
  type IdentityProvider,
  type IdentityResolutionErrorKind,
  type ResolveIdentityOptions,
  type ResolvedIdentity,
} from "./identity";

export {
  functionContract,
  FunctionCallError,
  type AnyFunctionContract,
  type BoundFunction,
  type FunctionCallOptions,
  type FunctionCallResult,
  type FunctionContract,
  type FunctionDefLike,
  type FunctionErrorEnvelope,
  type FunctionInput,
  type FunctionIssue,
  type FunctionOutput,
  type FunctionReturn,
  type FunctionsNamespace,
} from "./functions";

export {
  ActionRejectedError,
  ActionResolutionError,
  type ActionDrafts,
  type ActionRejection,
  type CreatedEntity,
  type DraftCreateOptions,
  type DraftDuplicateOptions,
  type DraftNamespace,
  type DuplicateAt,
  type EntityWriteOptions,
  type GroupRef,
  type MembershipDraftNamespace,
  type SystemDraftNamespace,
} from "./sync/drafts";

export {
  PermissionError,
  type MissingPermissionViolation,
  type PermissionViolation,
  type PermissionVerb,
  type PermissionQuery,
  type SourceMismatchViolation,
  type TypeMismatchViolation,
  type CanResult,
  type CanSubject,
  type CanUnknownReason,
} from "./sync/permission";

export { ComponentVersionAheadError, type ComponentMigrations } from "./sync/migrations";

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
  filterToGroups,
} from "./sync/query";

export {
  type Plan,
  type PlanOp,
  type PlanPredicate,
  planQuery,
  readComponentsFor,
  rowReadComponentsFor,
} from "./sync/query-plan";

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
export {
  DEFAULT_HISTORY_LIMIT,
  type HistoryEvent,
  type HistoryOptions,
  type ReplayOptions,
} from "./sync/history";
export type { EntityDiff, ManyPointerValue } from "@ebbjs/write";
export { isUnset, unset, type Unset } from "@ebbjs/core";
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
  type EntityValues,
  type EntityPatch,
  type EntityNamespaces,
  type EntityRow,
  type EntitySnapshot,
  type EntityWithAccessors,
  type MembershipNamespace,
  type GroupNamespace,
  type MembershipAccessors,
  type QueryRoot,
  type QueryRowOf,
  type RowAccessor,
  createEntityNamespace,
  buildEntityNamespaces,
  type ReplicaAccess,
} from "./sync/namespace";
export {
  definePresence,
  DEFAULT_PRESENCE_DEBOUNCE_MS,
  DEFAULT_PRESENCE_MAX_ENTRIES,
  DEFAULT_PRESENCE_TTL_MS,
  MAX_PRESENCE_PAYLOAD_BYTES,
  PresencePayloadTooLargeError,
  PresenceValidationError,
  UndeclaredPresenceChannelError,
  type AnyPresenceRegistry,
  type CursorPresence,
  type NormalizedPresenceChannel,
  type PeerPresence,
  type PresenceApi,
  type PresenceChange,
  type PresenceChannelConfig,
  type PresenceChannelOptions,
  type PresenceChannelSpec,
  type PresenceChannels,
  type PresenceChannelsMap,
  type PresenceChannelsOf,
  type PresenceRegistry,
  type PresenceSendOptions,
  type PresenceValue,
} from "./presence/presence";

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
  type ConflictChangeListener,
  type ConflictSnapshot,
  type ResolveResult,
  type FailedResolution,
} from "./sync/conflicts";

export { type ReadonlyObservable } from "./sync/observable";

export { type ClientStatus } from "./sync/status";

export type { ConflictEntry } from "./sync/conflicts";
export type {
  ConflictHold,
  ConflictSide,
  ConflictSlot,
  ConflictRemoteAction,
} from "@ebbjs/storage/types";

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
} from "@ebbjs/schema";

export {
  applyActions,
  applyUpdate,
  appendOnlyViolations,
  assertAppendOnly,
  AppendOnlyViolationError,
  contentFieldFromCells,
  contentKeys,
  docActionToUpdate,
  DocumentVersionError,
  isDocSubjectUpdate,
  parseContentField,
  readCellFields,
  DEFAULT_DOC_SUBJECT_TYPE,
  CURRENT_TEXT_VERSION,
  DOC_VERSION_FIELD,
} from "@ebbjs/schema";

export {
  AnchorSchema,
  CellFieldValueSchema,
  CutCellSchema,
  RunCellSchema,
  TextCellSchema,
  DOC_CONTENT_FIELD,
} from "@ebbjs/schema";

export {
  applyCellFields,
  compareRuns,
  createDocState,
  makeCutId,
  makeRunId,
  parseRunId,
  project,
  reconstruct,
  lookupPosition,
  runOffsetToPosition,
  ROOT_ID,
  type CellFieldValue,
  type CutCell,
  type DocState,
  type RunCell,
  type TextCell,
  type RunSpan,
  type PositionIndex,
  type PositionLookup,
} from "@ebbjs/schema";

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
  defineModel,
  e,
  type ModelDef,
  type ModelOptions,
  type FieldMarker,
  type ConflictScope,
  type Materialization,
  type MapSchema,
  type TSchema,
} from "@ebbjs/schema";

export {
  defineRelationship,
  type RelationshipDef,
  type SourceCardinality,
  type DefineRelationshipInput,
} from "@ebbjs/schema";

export {
  ModelRegistry,
  EntityValidationError,
  type Filter,
  type FilterGroup,
  type ValidationViolation,
} from "@ebbjs/schema";

export {
  defineSchema,
  ModelKeyMismatchError,
  UnregisteredRelationshipEndpointError,
  type DefineSchemaInput,
  type Schema,
} from "@ebbjs/schema";

export { ReservedNameError, PLATFORM_NAMESPACE, RESERVED_MEMBERSHIP_NAMES } from "@ebbjs/schema";

export {
  EBB_COMPONENT_KINDS,
  EBB_COMPONENTS,
  EBB_MODEL_NAME,
  ebbComponent,
  ebbComponentField,
  ebbComponentKind,
  ebbSystemEntity,
  isEbbComponent,
  GROUPS_ACCESSOR,
  type EbbComponentKind,
  type GroupFields,
  type GroupMemberFields,
  type EntityGroupFields,
  type RelationshipFields,
} from "@ebbjs/schema";
