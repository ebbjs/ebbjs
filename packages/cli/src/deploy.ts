import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

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
  CliHttpError,
  listFunctions,
  listVersions,
  uploadVersion,
  type FetchLike,
  type FunctionSummary,
  type FunctionVersionInfo,
} from "./api.ts";
import { loadConfig, type ResolvedConfig } from "./config.ts";
import { deploymentHashFor } from "./deployment-hash.ts";
import {
  checkDrift,
  hasDrift,
  writeContractMap,
  type ContractDrift,
  type ContractEntry,
} from "./contract-map.ts";
import { displayPath, isEntryFile, isMissingFile, isRecord, messageOf } from "./util.ts";

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
  /** `--force` uploads and activates even when the deployment is unchanged. */
  force?: boolean;
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
  /** True when the deployment hash already existed and nothing was uploaded. */
  unchanged: boolean;
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

/**
 * Recursive and sorted: a project may group entries under the functions
 * directory, and a deploy should visit them in the same order every time.
 */
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

/**
 * Each file's declared name, read from its source. The contract map keys and
 * type imports must match the deployed name, not the file name.
 */
export async function discoverEntrySpecs(dir: string): Promise<ContractEntry[]> {
  const paths = await discoverEntries(dir);
  return Promise.all(
    paths.map(async (path) => ({
      name: definitionName(await readFile(path, "utf8")),
      path,
    })),
  );
}

export async function deployEntries(options: DeployOptions = {}): Promise<DeployResult> {
  const config = await configFor(options);
  const entries = await discoverEntrySpecs(config.functions.dir);
  return deployEntriesFor(entries, options, config, entries);
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
  const entries = await discoverEntrySpecs(config.functions.dir);
  const selected = new Set(paths.map((path) => resolve(config.cwd, path)));
  const changed = entries.filter((entry) => selected.has(resolve(entry.path)));
  return deployEntriesFor(changed, options, config, entries);
}

/** Regenerates the contract map from the current entries on disk. */
export async function writeTypes(config: ResolvedConfig): Promise<string> {
  const entries = await discoverEntrySpecs(config.functions.dir);
  return writeContractMap(entries, config.functions.typesOut, {
    cwd: config.cwd,
    displayPath: displayPath(config.cwd, config.functions.typesOut),
  });
}

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
    unchanged: false,
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

async function deployEntriesFor(
  entries: readonly ContractEntry[],
  options: DeployOptions,
  config: ResolvedConfig,
  mapEntries: readonly ContractEntry[],
): Promise<DeployResult> {
  const print = options.print ?? console.log;
  const functions: DeployedFunction[] = [];

  for (const entry of entries) {
    const prepared = await prepareDeployment(entry.path, options);
    const { envelope, code, name, version } = prepared;
    // Bundling still runs: the digest of the emitted code is part of the hash.
    const deploymentHash = deploymentHashFor(envelope);

    // A pin belongs to a version row and there is no pin route, so `--keep`
    // is an explicit request for a new pinned version, not a no-op.
    const reuse =
      options.force === true || options.keep === true
        ? null
        : await matchingVersion(config, name, deploymentHash, options.fetchImpl);

    if (reuse !== null) {
      // An unchanged deploy that is already up to date needs no activation, and
      // `--no-activate` must leave the pointer alone either way.
      const activated = options.activate !== false && reuse.status !== "active";
      print(`unchanged ${name}@${reuse.version}`);

      if (activated) {
        await activateVersion(config, name, reuse.version, { fetchImpl: options.fetchImpl });
        print(`activated ${name}@${reuse.version}`);
      }

      functions.push({
        ...prepared,
        version: reuse.version,
        envelope: { ...prepared.envelope, version: reuse.version },
        activated,
        unchanged: true,
      });
      continue;
    }

    await uploadVersion(
      config,
      name,
      { envelope, code, pinned: options.keep === true, deploymentHash },
      { fetchImpl: options.fetchImpl },
    );
    print(`deployed ${name}@${version}`);

    const activated = options.activate !== false;
    if (activated) {
      await activateVersion(config, name, version, { fetchImpl: options.fetchImpl });
      print(`activated ${name}@${version}`);
    } else {
      print(`left ${name} active version unchanged`);
    }

    print(`grant function.${name}`);
    functions.push({ ...prepared, activated, unchanged: false });
  }

  const typesOut = config.functions.typesOut;
  if (options.writeTypes !== false) {
    await writeTypes(config);
  }

  const drift =
    options.checkDrift === false
      ? null
      : await reportDrift(config, mapEntries, options.fetchImpl, print);

  return { functions, drift, typesOut };
}

/**
 * An uploaded version that already carries this deployment hash: the active
 * one if there is one, otherwise the newest duplicate. A name with no history
 * at all is not an error: it has nothing to match.
 */
async function matchingVersion(
  config: ResolvedConfig,
  name: string,
  deploymentHash: string,
  fetchImpl: FetchLike | undefined,
): Promise<FunctionVersionInfo | null> {
  let versions: FunctionVersionInfo[];
  try {
    versions = (await listVersions(config, name, { fetchImpl })).versions;
  } catch (error) {
    if (error instanceof CliHttpError && error.status === 404 && error.code === "not_found") {
      return null;
    }
    throw error;
  }

  const matches = versions.filter((version) => version.deploymentHash === deploymentHash);

  // The active row wins over a newer duplicate: the duplicate adds nothing a
  // deploy wants, and moving the pointer to it would silently undo a rollback.
  const active = matches.find((version) => version.status === "active");
  if (active !== undefined) return active;

  // History arrives newest first; compare on `createdAt` so a caller that
  // reorders it cannot pick an older duplicate of the same deployment.
  return matches.reduce<FunctionVersionInfo | null>(
    (newest, version) =>
      newest === null || version.createdAt > newest.createdAt ? version : newest,
    null,
  );
}

async function reportDrift(
  config: ResolvedConfig,
  entries: readonly ContractEntry[],
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
