# Slice 5: Server Function Invocation

## Goal

A client can invoke a server function by name, the Elixir server forwards the invocation to the Bun Application Server, and the Bun function can read entities (via `ctx.get`/`ctx.query`) and write Actions (via `ctx.create`/`ctx.update`/`ctx.delete`) through the Elixir HTTP API, with all reads returning zero-staleness materialized state.

## Components Involved

| Component                                                 | Interface Subset Used                                                                                                                           |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| [HTTP API](../components/http-api.md)                     | `POST /functions/:name` (client-facing), `GET /entities/:id`, `POST /entities/query`, `POST /entities/batch`, `POST /sync/actions` (Bun-facing) |
| [Entity Store](../components/entity-store.md)             | `get/2`, `query/3`, `get_batch/2`                                                                                                               |
| [Writer](../components/writer.md)                         | `WriterRouter.route_write/1` (for Bun's `ctx.create`/`ctx.update`/`ctx.delete`)                                                                 |
| [Permission Checker](../components/permission-checker.md) | `validate_and_authorize/2` (for Bun's write Actions)                                                                                            |
| [SQLite Store](../components/sqlite-store.md)             | `get_active_function/1` (function version lookup)                                                                                               |

## Flow

1. **Client invokes function.** `POST /functions/summarize_todos {"list_id": "list_abc"}` with auth headers.

2. **Elixir authenticates.** AuthPlug forwards auth headers to the developer's auth URL → `actor_id: "a_user1"`.

3. **Elixir looks up function.** `SQLite.get_active_function("summarize_todos")` → `{:ok, %{name: "summarize_todos", version: "v3", status: "active"}}`.

4. **Elixir forwards to Bun.** HTTP POST to `http://localhost:3001/invoke`:

   ```json
   {
     "function": "summarize_todos",
     "version": "v3",
     "input": { "list_id": "list_abc" },
     "actor_id": "a_user1",
     "server_url": "http://localhost:4000"
   }
   ```

5. **Bun executes function.** The function handler runs in a `vm` sandbox with a `ctx` object:

   ```typescript
   // In Bun
   async function handler(ctx, input) {
     // ctx.query calls Elixir
     const todos = await ctx.query("todo", { list_id: input.list_id });

     // ctx.create calls Elixir
     const summary = await ctx.create("summary", {
       list_id: input.list_id,
       total: todos.length,
       completed: todos.filter((t) => t.data.fields.completed.value).length,
     });

     return { summary_id: summary.id };
   }
   ```

6. **Bun reads entities via Elixir HTTP.** `ctx.query("todo", {list_id: "list_abc"})` → `POST http://localhost:4000/entities/query {"type": "todo", "filter": {"list_id": "list_abc"}, "actor_id": "a_user1"}`.

7. **Elixir Entity Store materializes and queries.** On-demand materialization ensures zero-staleness. Returns JSON array of entities.

8. **Bun writes via Elixir HTTP.** `ctx.create("summary", data)` → `POST http://localhost:4000/sync/actions` with a MessagePack-encoded Action containing a PUT Update.

9. **Elixir Permission Checker validates.** The Action's `actor_id` is `a_user1`. Permission checks run normally (the server function runs with the invoking user's permissions).

10. **Elixir Writer commits.** Action is durable. GSN assigned. Fan-out notifies subscribers.

11. **Bun returns result.** `{"summary_id": "summary_xyz"}`.

12. **Elixir returns to client.** `200 {"summary_id": "summary_xyz"}`.

## Acceptance Criteria

- [ ] `POST /functions/:name` authenticates the client and looks up the active function version
- [ ] Elixir forwards the invocation to Bun with correct function name, version, input, and actor_id
- [ ] Bun's `ctx.get(id)` calls `GET /entities/:id` and receives the materialized entity
- [ ] Bun's `ctx.query(type, filter)` calls `POST /entities/query` and receives filtered results
- [ ] Bun's `ctx.create(type, data)` calls `POST /sync/actions` and the Action is committed
- [ ] Server function reads are zero-staleness (entity written by `ctx.create` in the same function is immediately readable by a subsequent `ctx.get`)
- [ ] Server function writes are permission-checked (actor must have appropriate Group permissions)
- [ ] Function invocation timeout is enforced (Bun's `vm` sandbox kills long-running functions)
- [ ] `POST /functions/:name` returns 404 if no active function version exists
- [ ] Errors in the function (thrown exceptions) return a structured error response to the client
- [ ] Writes committed before an error are NOT rolled back (no transactional semantics)

## Build Order

1. **Add function version management to SQLite Store.** Implement `get_active_function/1` and `upsert_function_version/1`. Add the `function_versions` table to the DDL. Write unit tests.

2. **Seed a test function version.** For testing, insert a function version record directly into SQLite (or via a test helper). The full deploy CLI (`ebb deploy`) is out of scope for this slice.

3. **Build the function invocation endpoint.** `POST /functions/:name` in the HTTP router:
   - Authenticate
   - Look up active function version
   - Forward to Bun via HTTP
   - Return Bun's response

4. **Build the Bun-facing entity endpoints (if not already complete).** `GET /entities/:id`, `POST /entities/query`, `POST /entities/batch`. These were partially built in Slices 1-2 but may need adjustments for the Bun use case (e.g., batch endpoint).

5. **Stub the Bun Application Server.** For integration testing, create a minimal Bun server at `localhost:3001` that:
   - Receives `/invoke` requests
   - Executes a hardcoded test function that calls `ctx.get`, `ctx.query`, `ctx.create`
   - Returns the result

6. **Integration test: read-only function.** Invoke a function that only reads entities. Verify correct data returned.

7. **Integration test: read-write function.** Invoke a function that reads, then writes, then reads the written entity. Verify zero-staleness (the second read sees the write).

8. **Integration test: permission enforcement.** Invoke a function where the actor lacks permissions for a write. Verify the write is rejected but the function continues (or returns an error, depending on the Bun SDK's error handling).

9. **Integration test: function not found.** Invoke a non-existent function. Verify 404 response.
