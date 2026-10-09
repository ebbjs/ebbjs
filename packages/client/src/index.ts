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
  type QueryBuilder,
  type QueryContext,
  type PointerValue,
  projectEntity,
  projectRows,
  buildQueryBuilder,
  buildLazyQueryBuilder,
  type LoadEntities,
} from "./sync/query-builder";

export {
  type EntityNamespace,
  type EntityFields,
  type EntityNamespaces,
  type EntityRow,
  type EntitySnapshot,
  type EntityWithAccessors,
  type MembershipAccessors,
  type RowAccessor,
  type CreateOptions,
  type EntityWriteOptions,
  type GroupRef,
  createEntityNamespace,
  buildEntityNamespaces,
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
  type OutboxStatus,
  type FlushOutcome,
  type InboundOutcome,
} from "./sync/outbox";

export { type FlushScheduler } from "./sync/flush-scheduler";

export {
  type Conflicts,
  type ConflictResolution,
  type ConflictChangeListener,
} from "./sync/conflicts";

export type { ConflictEntry, ConflictWinner } from "@ebbjs/storage/types";

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
  DEFAULT_DOCUMENT_ENTITY,
  DOC_CONTENT_FIELD,
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
  type FieldMarker,
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
  type DefineSchemaInput,
  type ExpandedEntities,
  type Schema,
} from "./schema/schema";

export {
  ReservedNameError,
  RESERVED_ENTITY_NAMES,
  RESERVED_MEMBERSHIP_NAMES,
} from "./schema/reserved";

export {
  relationshipSystemEntity,
  groupSystemEntity,
  groupMemberSystemEntity,
  entityGroupSystemEntity,
  GROUPS_ACCESSOR,
  type GroupFields,
  type EntityGroupFields,
} from "./schema/system-entities";
