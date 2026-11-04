import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { FunctionBundleError, bundleSource, definitionName } from "./bundle.ts";
import {
  DEFAULT_MEMORY_BYTES,
  DEFAULT_TIMEOUT_MS,
  buildEnvelope,
  digestFor,
  validateEnvelope,
  type FunctionAccess,
  type FunctionEnvelope,
} from "./envelope.ts";
import {
  activateVersion,
  listFunctions,
  uploadVersion,
  type FetchLike,
  type FunctionSummary,
} from "./api.ts";
import { loadConfig, type ResolvedConfig } from "./config.ts";
import { checkDrift, hasDrift, writeContractMap, type ContractDrift } from "./contract-map.ts";

export interface DeployOptions {
  cwd?: string;
  config?: ResolvedConfig;
  configPath?: string;
  url?: string;
  token?: string;
  actor?: string;
  /** Defaults to true; `--no-activate` turns it off. */
  activate?: boolean;
  /** `--keep` pins the uploaded version against retention. */
  keep?: boolean;
  /** Pins the version for every entry; tests use it instead of the clock. */
  version?: string;
  fetchImpl?: FetchLike;
  print?: (line: string) => void;
  /** Defaults to true. The dev watcher writes the map once per pass itself. */
  writeTypes?: boolean;
  /** Defaults to true. */
  checkDrift?: boolean;
}

export interface DeployedFunction {
  name: string;
  version: string;
  entryPath: string;
  envelope: FunctionEnvelope;
  code: string;
  activated: boolean;
  pinned: boolean;
}

export interface DeployResult {
  functions: DeployedFunction[];
  drift: ContractDrift | null;
  typesOut: string;
}

interface FunctionDefinition {
  access?: FunctionAccess;
  timeoutMs?: number;
  memoryMb?: number;
  params?: { toJSONSchema?: () => Record<string, unknown> };
  output?: { toJSONSchema?: () => Record<string, unknown> };
}

const ENTRY_EXTENSION = /\.ts$/;
const NOT_AN_ENTRY = /\.(?:d\.ts|test\.ts)$/;

/** Every `*.ts` entry under `dir`, sorted by path, recursively. */
export async function discoverEntries(dir: string): Promise<string[]> {
  const paths: string[] = [];

  const walk = async (current: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (isMissingFile(error)) return;
      throw error;
    }

    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && isEntryFile(entry.name)) paths.push(path);
    }
  };

  await walk(dir);
  return paths.sort();
}

/** Deploys every entry under the configured functions directory. */
export async function deployEntries(options: DeployOptions = {}): Promise<DeployResult> {
  const config = await configFor(options);
  const paths = await discoverEntries(config.functions.dir);
  return deployPaths(paths, options, config, paths);
}

/**
 * Deploys only `paths`, while regenerating the map from every entry under the
 * functions directory. The dev watcher passes the changed entries here.
 */
export async function deployFiles(
  paths: readonly string[],
  options: DeployOptions = {},
): Promise<DeployResult> {
  const config = await configFor(options);
  const discovered = await discoverEntries(config.functions.dir);
  const selected = paths.map((path) => resolve(config.cwd, path)).sort();
  const all = uniqueSorted([...discovered, ...selected]);
  return deployPaths(selected, options, config, all);
}

/** Reads, bundles, and evaluates one entry into the upload payload. */
export async function prepareDeployment(
  entryPath: string,
  options: DeployOptions = {},
): Promise<DeployedFunction> {
  const source = await readFile(entryPath, "utf8");
  const name = definitionName(source);
  const code = await bundleSource(source, entryPath, name);
  const definition = evaluateDefinition(code, name);

  const version = options.version ?? new Date().toISOString();
  const envelope = buildEnvelope({
    name,
    version,
    code,
    digest: digestFor(code),
    access: definition.access ?? "granted",
    timeoutMs: definition.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    memoryBytes:
      definition.memoryMb === undefined ? DEFAULT_MEMORY_BYTES : definition.memoryMb * 1024 * 1024,
    entry: name,
    paramsSchema: definition.params?.toJSONSchema?.() ?? null,
    outputSchema: definition.output?.toJSONSchema?.() ?? null,
  });

  const problems = validateEnvelope(envelope);
  if (problems.length > 0) {
    throw new FunctionBundleError(
      problems.map((problem) => `${problem.field}: ${problem.message}`),
    );
  }

  return {
    name,
    version,
    entryPath,
    envelope,
    code,
    activated: false,
    pinned: options.keep === true,
  };
}

/**
 * The IIFE is evaluated exactly as the runner does it: the exports object the
 * bundle leaves on the global is the definition map. The bound name is the
 * entry, so reading it cannot pick up another exported helper.
 */
export function evaluateDefinition(code: string, name: string): FunctionDefinition {
  const factory = new Function(
    `${code}\nreturn typeof __ebbFunction === "object" && __ebbFunction !== null ? __ebbFunction : {};`,
  ) as () => Record<string, unknown>;
  const exported = factory();
  const definition = exported[name];

  if (!isRecord(definition)) {
    throw new FunctionBundleError([
      `the bundle does not export a definition named ${JSON.stringify(name)}`,
    ]);
  }

  return definition as FunctionDefinition;
}

async function deployPaths(
  paths: readonly string[],
  options: DeployOptions,
  config: ResolvedConfig,
  mapEntries: readonly string[],
): Promise<DeployResult> {
  const print = options.print ?? console.log;
  const functions: DeployedFunction[] = [];

  for (const path of paths) {
    const prepared = await prepareDeployment(path, options);
    const { envelope, code, name, version } = prepared;

    await uploadVersion(
      config,
      name,
      { envelope, code, pinned: options.keep === true },
      { fetchImpl: options.fetchImpl },
    );
    print(`deployed ${name}@${version}`);

    if (options.activate === false) {
      print(`left ${name} active version unchanged`);
    } else {
      await activateVersion(config, name, version, { fetchImpl: options.fetchImpl });
      prepared.activated = true;
      print(`activated ${name}@${version}`);
    }

    print(`grant function.${name}`);
    functions.push(prepared);
  }

  const typesOut = config.functions.typesOut;
  if (options.writeTypes !== false) {
    await writeContractMap(mapEntries, typesOut, {
      cwd: config.cwd,
      displayPath: displayPath(config.cwd, typesOut),
    });
  }

  const drift =
    options.checkDrift === false
      ? null
      : await reportDrift(config, mapEntries, options.fetchImpl, print);

  return { functions, drift, typesOut };
}

async function reportDrift(
  config: ResolvedConfig,
  entries: readonly string[],
  fetchImpl: FetchLike | undefined,
  print: (line: string) => void,
): Promise<ContractDrift | null> {
  if (!config.actor && !config.headers) {
    print("drift check skipped: no actor credential in ebb.config.ts");
    return null;
  }

  try {
    const response = await listFunctions(config, { fetchImpl });
    const names = response.functions.map((fn: FunctionSummary) => fn.name);
    const drift = checkDrift(entries, names);

    if (hasDrift(drift)) {
      print("warning: contract map drift");
      for (const name of drift.missing) {
        print(`  missing: ${name} is deployed but has no local entry`);
      }
      for (const name of drift.extra) {
        print(`  extra: ${name} has a local entry but no deployed version`);
      }
    }

    return drift;
  } catch (error) {
    print(`drift check failed: ${messageOf(error)}`);
    return null;
  }
}

async function configFor(options: DeployOptions): Promise<ResolvedConfig> {
  if (options.config) return options.config;
  return loadConfig(options.cwd ?? process.cwd(), {
    config: options.configPath,
    url: options.url,
    token: options.token,
    actor: options.actor,
  });
}

function isEntryFile(name: string): boolean {
  return ENTRY_EXTENSION.test(name) && !NOT_AN_ENTRY.test(name);
}

function displayPath(cwd: string, path: string): string {
  return relative(cwd, path).replaceAll("\\", "/");
}

function uniqueSorted(paths: readonly string[]): string[] {
  return [...new Set(paths)].sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
