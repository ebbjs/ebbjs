import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

import { isMissingFile, isRecord, messageOf } from "./util.ts";

export const DEFAULT_URL = "http://localhost:4000";
export const DEFAULT_FUNCTIONS_DIR = "functions";
export const DEFAULT_TYPES_OUT = "src/ebb-functions.generated.ts";
export const DEFAULT_CONFIG_FILE = "ebb.config.ts";

/** The config the rest of the CLI works from, with paths resolved against cwd. */
export interface ResolvedConfig {
  cwd: string;
  url: string;
  token?: string;
  actor?: string;
  headers?: Record<string, string>;
  functions: {
    /** Absolute path to the directory holding function entries. */
    dir: string;
    /** Absolute path of the generated contract map. */
    typesOut: string;
  };
  /** Absolute path of the config file when one was loaded. */
  configPath?: string;
}

interface FileConfig {
  url?: unknown;
  token?: unknown;
  actor?: unknown;
  headers?: unknown;
  functions?: {
    dir?: unknown;
    typesOut?: unknown;
  };
}

export interface LoadConfigOptions {
  /** Overrides the default `ebb.config.ts`. Relative paths are resolved from cwd. */
  config?: string;
  url?: string;
  token?: string;
  actor?: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Loads `ebb.config.ts` and resolves it against `cwd`.
 *
 * The file is bundled and evaluated as ESM, so it can import `defineConfig`
 * from `@ebbjs/server` without the project needing a runner for TypeScript.
 * Flags win over the file, and an absent file is the documented defaults, not
 * an error.
 */
export async function loadConfig(
  cwd: string = process.cwd(),
  options: LoadConfigOptions = {},
): Promise<ResolvedConfig> {
  const configPath = resolve(cwd, options.config ?? DEFAULT_CONFIG_FILE);
  const loadedConfig = await readConfig(configPath);
  const loaded = loadedConfig ?? {};

  const url = options.url ?? loaded.url ?? DEFAULT_URL;
  const token = options.token ?? loaded.token;
  const actor = options.actor ?? loaded.actor;
  const headers = loaded.headers;
  const functions = loaded.functions ?? {};

  const config: ResolvedConfig = {
    cwd,
    url: requireString(url, "url"),
    functions: {
      dir: resolve(
        cwd,
        requireOptionalString(functions.dir, "functions.dir") ?? DEFAULT_FUNCTIONS_DIR,
      ),
      typesOut: resolve(
        cwd,
        requireOptionalString(functions.typesOut, "functions.typesOut") ?? DEFAULT_TYPES_OUT,
      ),
    },
  };

  if (token !== undefined) config.token = requireString(token, "token");
  if (actor !== undefined) config.actor = requireString(actor, "actor");
  if (headers !== undefined) config.headers = requireHeaders(headers);
  if (loadedConfig !== undefined) config.configPath = configPath;

  return config;
}

async function readConfig(path: string): Promise<FileConfig | undefined> {
  try {
    await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }

  let code: string;
  try {
    const result = await build({
      entryPoints: [path],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      write: false,
      logLevel: "silent",
      // A project under a temp directory may not have its own node_modules
      // yet; the CLI's install can still supply `@ebbjs/server`.
      nodePaths: [resolve(dirname(fileURLToPath(import.meta.url)), "..", "node_modules")],
    });
    code = result.outputFiles[0]?.text ?? "";
  } catch (error) {
    throw new ConfigError(`could not load ${path}: ${messageOf(error)}`);
  }

  const url = `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
  const module = (await import(url)) as { default?: unknown };
  const config = module.default;

  if (!isRecord(config) || Array.isArray(config)) {
    throw new ConfigError(
      `${path} must default-export a config object, for example \`export default defineConfig({ ... })\``,
    );
  }

  return config as FileConfig;
}

function requireOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, field);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new ConfigError(`ebb.config.ts field \`${field}\` must be a string`);
  }
  return value;
}

function requireHeaders(value: unknown): Record<string, string> {
  if (!isRecord(value) || Array.isArray(value)) {
    throw new ConfigError("ebb.config.ts field `headers` must be an object of string values");
  }
  for (const [name, header] of Object.entries(value)) {
    if (typeof header !== "string") {
      throw new ConfigError(`ebb.config.ts header \`${name}\` must be a string`);
    }
  }
  return value as Record<string, string>;
}
