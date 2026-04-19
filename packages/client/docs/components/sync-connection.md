# SyncConnection

## Purpose

Manages the HTTP connection to the ebb_server, providing typed request methods that automatically include the `x-ebb-actor-id` header. This is the only component that knows about the server's HTTP API.

## Responsibilities

- Send HTTP requests to ebb_server with actor-id header
- Handle JSON and MessagePack response bodies
- Surface server errors as typed errors
- Never expose raw fetch internals

## Public Interface

```typescript
interface SyncConnection {
  /** Base URL of the ebb_server (e.g. "http://localhost:4000") */
  readonly baseUrl: string;
  /** Actor ID used for all requests */
  readonly actorId: string;

  /** POST /sync/actions — write actions (unused in v1 read-only) */
  postActions(actions: Action[]): Promise<WriteActionsResponse>;

  /** POST /sync/handshake — initialize connection */
  handshake(cursors?: Record<string, number>): Promise<HandshakeResponse>;

  /** GET /sync/groups/:groupId?offset=cursor — catchup on a group */
  catchUpGroup(groupId: string, offset?: number): Promise<CatchUpResponse>;

  /** GET /entities/:id — read a single entity (used to verify state) */
  getEntity(entityId: string): Promise<Entity>;
}
```

### Types

```typescript
interface HandshakeResponse {
  actor_id: string;
  groups: Array<{
    id: string;
    permissions: string[];
    cursor_valid: boolean;
    reason: string | null;
    cursor: number;
  }>;
}

interface CatchUpResponse {
  actions: Action[];
  nextOffset: number | null; // from stream-next-offset header, null if done
  upToDate: boolean; // from stream-up-to-date header
}

interface WriteActionsResponse {
  rejected: Array<{ id: string; reason: string; details?: string }>;
}
```

## Internal Design Notes

- **Functional** — created via `createSyncConnection(baseUrl, actorId)` factory, not a class
- Uses the built-in `fetch` API
- All requests include `x-ebb-actor-id: <actorId>` header
- Response headers `stream-next-offset` and `stream-up-to-date` are parsed and returned as structured fields
- Errors from the server are thrown as `Error` with the server's error JSON in `message`

### Factory Signature

```typescript
const createSyncConnection = (baseUrl: string, actorId: string): SyncConnection => {
  // returns a plain object implementing SyncConnection
  // no class, no `new`, no `this`
};
```

## Open Questions

- None for v1 read-only scope
