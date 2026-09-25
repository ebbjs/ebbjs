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
 *   with local edit API, onUpdate/onConflict events, and pendingActions
 *   queue for `client.write()`.
 *
 * Slice 3 adds the bridge package `@ebbjs/codemirror` (peer dep) plus
 * presence (ephemeral cursors/selections).
 */

export {
  SyncClient,
  createClient,
  type HandshakeResult,
  type QueryOptions,
  type RelationshipHandle,
} from "./sync/client";
export { PresenceManager, type PresenceEntry, type CursorPresence } from "./presence/presence";

export {
  ConnectionStateMachine,
  type ConnectionState,
  type StateChangeListener,
} from "./sync/connection-state";

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
  type ConflictListener,
} from "./fields/collaborative-text/text-document";

export {
  ConflictDetector,
  type Conflict,
  type RunSnapshot,
  happensBefore,
} from "./fields/collaborative-text/conflict";

export {
  applyActions,
  docActionToUpdate,
  diffRunFields,
  diffRunFieldsForDeleteRange,
  isDocSubjectUpdate,
  DEFAULT_DOC_SUBJECT_TYPE,
  RUN_FIELD_PREFIX,
  formatRunFieldName,
  parseRunFieldName,
} from "./fields/collaborative-text/wire";

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
  Action,
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

export { defineEntity, type EntityDef, type FieldMarker } from "./schema/entity";

export {
  defineRelationship,
  type RelationshipDef,
  type SourceCardinality,
  type DefineRelationshipInput,
} from "./schema/relationship";

export {
  EntityRegistry,
  EntityValidationError,
  type ValidationViolation,
} from "./schema/entity-registry";

export { defineSchema, type DefineSchemaInput, type Schema } from "./schema/schema";

export {
  buildQueryBuilder,
  apply as applyQueryPlan,
  type QueryBuilder,
  type QueryPlan,
  type EqFilter,
  type OrderBy,
} from "./sync/query-builder";

export { getFieldValue, hasField, stripField } from "./sync/entity-fields";

export { buildEntityHandle, type EntityHandle } from "./sync/handle";

export {
  mountNamespace,
  type EntityCollection,
  type CreateInput,
  type UpdateInput,
  type NamespacedClient,
} from "./sync/namespace";
