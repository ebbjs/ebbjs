# Server Harness

## Purpose

Provides lifecycle management for the bundled `ebb_server` executable — start, wait for ready, and kill. Used by integration tests and CLI commands that need to run the server as a subprocess.

## Bundled Release

The `ebb_server` release is built and bundled as part of `@ebbjs/server`'s build step. The harness always uses this bundled release — callers never specify a path to an external server binary.

```
packages/server/
  dist/
    index.js           # TypeScript output
    ebb_server/        # Bundled Elixir release
      bin/ebb_server   # Executable
      releases/        # BEAM bytecode + runtime
```

The release is built by running `mix release` in `ebb_server/` and copied into `dist/ebb_server/` during the package build. See [Build and Caching](#build-and-caching) for details.

## Why a harness package?

Running the server as a subprocess is the only way to get a fully-isolated, persistent server instance for testing. The harness abstracts away:

- Spawning with correct environment variables
- Polling for server readiness
- Graceful shutdown with SIGTERM, force-kill with SIGKILL if needed

## Public Interface

```typescript
interface ServerOptions {
  /** Path to the RocksDB data directory */
  dataDir: string;
  /** Port to listen on (default: 4000) */
  port?: number;
  /** Additional environment variables */
  env?: Record<string, string>;
}

interface RunningServer {
  /** OS process ID */
  pid: number;
  /** HTTP port the server is listening on */
  port: number;
  /** Base URL for HTTP requests */
  url: string;
  /** Path to the data directory */
  dataDir: string;
  /** Kill the server process */
  kill(): Promise<void>;
}

/** Start the server and wait for it to be ready to accept connections */
const startServer = async (opts: ServerOptions): Promise<RunningServer>;

/** Poll a URL until it returns 200, or throw on timeout */
const waitForReady = (url: string, timeoutMs?: number): Promise<void>;
```

## Factory Signature

```typescript
const createServerHarness = (): ServerHarness => ({
  startServer,
  waitForReady,
});
```

## Internal Design Notes

### Server startup

The release binary is resolved from the package bundle:

```typescript
const releaseBin = resolve(__dirname, "../ebb_server/bin/ebb_server");
```

The server is started in foreground mode via:

```bash
< bundled release >/bin/ebb_server start
```

Environment variables control runtime behavior:

```typescript
const env = {
  EBB_SERVER_PORT: String(opts.port ?? 4000),
  EBB_SERVER_DATA_DIR: opts.dataDir,
  EBB_SERVER_AUTH_MODE: "bypass", // required for integration tests
  ...opts.env,
};
```

The `start` command runs the server in the foreground. This is preferred over `daemon` mode because it makes cleanup deterministic (killing the foreground process terminates the server immediately).

### Readiness detection

The server does not have a dedicated health endpoint in v1. Readiness is determined by:

1. Attempting to connect to the server's HTTP port
2. If connection refused, retry after 200ms
3. Once connection succeeds, issue a `GET /entities/00000000000000000000000000` (a non-existent entity)
4. If we get a 404 (not found) response, server is ready (means router is up)
5. If we get a connection refused, keep retrying

### Shutdown

```typescript
const kill = async (child: ChildProcess): Promise<void> => {
  return new Promise((resolve) => {
    child.on("exit", () => resolve());
    child.kill("SIGTERM");
    setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5000);
  });
};
```

Grace period of 5 seconds before force-kill. The `ebb_server` trap_exit and cleanup on SIGTERM, so this covers normal shutdown. Force-kill is a fallback.

### Port selection

If `port` is not specified, default is `4000`. No automatic port selection in v1 — tests must use a consistent port. In a future version, port `0` could be used to let the OS pick an available port, but that complicates client configuration.

## Build and Caching

The release is built and bundled automatically during `pnpm build`.

**`scripts/build-release.js`**:

1. Runs `mix release` in `../../ebb_server/` (requires Elixir/Erlang)
2. Copies `_build/prod/rel/ebb_server/` to `../dist/ebb_server/`

**Incremental build (caching)**:

- Before building, checks if `dist/ebb_server/bin/ebb_server` exists
- Uses `find lib/ -name "*.ex" -newer <binary>` to detect if any source is newer
- If no source changes, skips `mix release` and just ensures the bundle is in `dist/`
- This avoids a ~30s recompilation when only TypeScript files changed

**Cache invalidation triggers**:

- Any `.ex` file in `ebb_server/lib/` is newer than the binary
- `ebb_server/mix.exs` changed (indicates dependency or config change)
- `ebb_server/mix.lock` changed (dependency version change)
- `dist/ebb_server/` is missing entirely

## Dependencies

None — uses only Node.js built-in `child_process` and `http`.

## Open Questions

- Should the harness support a `restart()` method to restart the server with the same options?
- Should there be a `logs()` method to stream stdout/stderr for debugging?
