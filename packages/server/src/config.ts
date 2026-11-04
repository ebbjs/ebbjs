/**
 * The shape of `ebb.config.ts`.
 *
 * The file is plain data: the CLI reads it for deploy, and `defineConfig`
 * exists only to type it, so an editor completes and checks the keys without
 * the config importing anything else from the SDK.
 */

export interface FunctionsConfig {
  /** Directory scanned for deploy entries. Defaults to "functions". */
  dir?: string;
  /** Generated contract-map path. Defaults to "src/ebb-functions.generated.ts". */
  typesOut?: string;
}

export interface EbbConfig {
  /** Server base URL. Defaults to http://localhost:4000. */
  url?: string;
  /** Admin deploy credential (`Authorization: Bearer`). Never an actor credential. */
  token?: string;
  /** Bypass-mode actor id for `GET /functions` / drift checks. */
  actor?: string;
  /** External-mode auth headers/cookie for `GET /functions`. */
  headers?: Record<string, string>;
  functions?: FunctionsConfig;
}

/** Types an `ebb.config.ts` default export without changing it. */
export function defineConfig(config: EbbConfig): EbbConfig {
  return config;
}
