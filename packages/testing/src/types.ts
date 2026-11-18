export interface ServerOptions {
  dataDir: string;
  port?: number;
  env?: Record<string, string>;
  /** Overrides the route and status {@link waitForReady} polls for. */
  readyCheck?: ReadyCheck;
}

/**
 * The request the readiness probe makes, and the status that answers it. The
 * defaults name a route the server routes but has no entity for, so a 404 is
 * "routed and serving" without writing anything.
 */
export interface ReadyCheck {
  path: string;
  expectedStatus: number;
}

export interface RunningServer {
  pid: number;
  port: number;
  url: string;
  dataDir: string;
  kill(): Promise<void>;
}
