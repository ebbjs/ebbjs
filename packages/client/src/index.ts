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

export { SyncClient, createClient, type HandshakeResult, type QueryOptions } from "./sync/client";
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
  type SSEHeaders,
} from "./sync/sse";

export { applyAction } from "./sync/storage";

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
} from "./sync/types";
