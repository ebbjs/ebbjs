import { existsSync, watch } from "node:fs";
import { basename, relative, resolve } from "node:path";

import {
  activateVersion,
  addAppOrigin,
  createApp,
  disable,
  getHealth,
  listApps,
  listFunctions,
  removeApp,
  removeAppOrigin,
  rollback,
  type App,
  type FetchLike,
} from "./api.ts";
import { isWildcardOrigin, normalizeOrigin } from "./apps.ts";
import { loadConfig, type LoadConfigOptions, type ResolvedConfig } from "./config.ts";
import { deployEntries, deployFiles, writeTypes, type DeployResult } from "./deploy.ts";
import { isEntryFile, messageOf } from "./util.ts";

export interface CommandDeps {
  cwd?: string;
  fetchImpl?: FetchLike;
  print?: (line: string) => void;
  printError?: (line: string) => void;
}

export interface WatchFunctionsOptions extends CommandDeps {
  config?: ResolvedConfig;
  configPath?: string;
  url?: string;
  token?: string;
  actor?: string;
  debounceMs?: number;
  deployAll?: (options: DeployOptionsForWatcher) => Promise<DeployResult>;
  deployChanged?: (
    paths: readonly string[],
    options: DeployOptionsForWatcher,
  ) => Promise<DeployResult>;
  signal?: AbortSignal;
}

type DeployOptionsForWatcher = Parameters<typeof deployEntries>[0];

export const USAGE = `Usage: ebb <command> [options]

Commands:
  ebb deploy [--no-activate] [--keep] [--force] [--url <url>] [--token <token>] [--config <path>]
  ebb functions list [--url <url>] [--actor <actor>] [--config <path>]
  ebb functions activate <name> <version> [--url <url>] [--token <token>] [--config <path>]
  ebb functions rollback <name> [--url <url>] [--token <token>] [--config <path>]
  ebb functions disable <name> [--url <url>] [--token <token>] [--config <path>]
  ebb functions health [--json] [--url <url>] [--token <token>] [--config <path>]
  ebb functions types [--config <path>]
  ebb apps list [--json] [--url <url>] [--token <token>] [--config <path>]
  ebb apps add <name> --origin <url> [--origin <url>]... [--url <url>] [--token <token>] [--config <path>]
  ebb apps remove <name> [--url <url>] [--token <token>] [--config <path>]
  ebb apps origin add <name> <url> [--url <url>] [--token <token>] [--config <path>]
  ebb apps origin remove <name> <url> [--url <url>] [--token <token>] [--config <path>]
  ebb dev [--url <url>] [--token <token>] [--actor <actor>] [--config <path>]

Options:
  --url <url>      Server base URL (default http://localhost:4000)
  --token <token>  Admin deploy credential
  --actor <actor>  Actor id for GET /functions and drift checks
  --config <path>  Config file (default ebb.config.ts)
  --no-activate    Upload without moving the active pointer
  --keep           Pin the uploaded version against retention (always uploads)
  --force          Upload and activate even when the deployment is unchanged
  --help           Show this help

Notes:
  ebb apps registers browser origins for CORS admission only. It is not
  authorization, and non-browser clients (CLI, functions) ignore CORS. Removing
  an origin takes effect when the browser's preflight cache expires (up to 300
  seconds). EBB_CORS_ALLOW_ANY stays a node environment setting resolved at
  boot; it is not an app and ebb apps does not toggle it.`;

class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

interface ParsedArgs {
  positionals: string[];
  values: Map<string, string>;
  lists: Map<string, string[]>;
  booleans: Set<string>;
}

export async function main(argv: readonly string[], deps: CommandDeps = {}): Promise<number> {
  const print = deps.print ?? console.log;
  const printError = deps.printError ?? console.error;

  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    print(USAGE);
    return 0;
  }

  try {
    return await dispatch([...argv], deps);
  } catch (error) {
    if (error instanceof UsageError) {
      printError(`error: ${error.message}`);
      printError("");
      printError(USAGE);
      return 1;
    }
    printError(`error: ${messageOf(error)}`);
    return 1;
  }
}

async function dispatch(argv: string[], deps: CommandDeps): Promise<number> {
  const print = deps.print ?? console.log;
  const command = argv[0];

  if (command === "deploy") {
    await deployCommand(
      parse(argv.slice(1), ["url", "token", "config"], ["no-activate", "keep", "force"]),
      deps,
    );
    return 0;
  }

  if (command === "functions") {
    return functionsCommand(argv.slice(1), deps);
  }

  if (command === "apps") {
    return appsCommand(argv.slice(1), deps);
  }

  if (command === "dev") {
    const parsed = parse(argv.slice(1), ["url", "token", "actor", "config"], []);
    assertNoPositionals(parsed, "dev");
    const values = flagValues(parsed);
    await devCommand(
      {
        cwd: deps.cwd ?? process.cwd(),
        configPath: values.config,
        url: values.url,
        token: values.token,
        actor: values.actor,
      },
      deps,
    );
    return 0;
  }

  if (command === "help") {
    print(USAGE);
    return 0;
  }

  throw new UsageError(`unknown command ${JSON.stringify(command)}`);
}

export async function deployCommand(parsed: ParsedArgs, deps: CommandDeps = {}): Promise<void> {
  assertNoPositionals(parsed, "deploy");
  const values = flagValues(parsed);

  await deployEntries({
    cwd: deps.cwd ?? process.cwd(),
    configPath: values.config,
    url: values.url,
    token: values.token,
    activate: !parsed.booleans.has("no-activate"),
    keep: parsed.booleans.has("keep"),
    force: parsed.booleans.has("force"),
    fetchImpl: deps.fetchImpl,
    print: deps.print ?? console.log,
  });
}

export async function listCommand(parsed: ParsedArgs, deps: CommandDeps = {}): Promise<void> {
  assertNoPositionals(parsed, "functions list");
  const config = await configFrom(flagValues(parsed), deps);
  const print = deps.print ?? console.log;
  const response = await listFunctions(config, { fetchImpl: deps.fetchImpl });

  for (const fn of response.functions) {
    print([fn.name, fn.version, fn.access, `function.${fn.name}`].join("\t"));
  }
}

export async function activateCommand(parsed: ParsedArgs, deps: CommandDeps = {}): Promise<void> {
  const [name, version] = requirePositionals(parsed, 2, "functions activate <name> <version>");
  const config = await configFrom(flagValues(parsed), deps);
  await activateVersion(config, name, version, fetchOptions(deps));
  (deps.print ?? console.log)(`activated ${name}@${version}`);
}

export async function rollbackCommand(parsed: ParsedArgs, deps: CommandDeps = {}): Promise<void> {
  const [name] = requirePositionals(parsed, 1, "functions rollback <name>");
  const config = await configFrom(flagValues(parsed), deps);
  const response = await rollback(config, name, fetchOptions(deps));
  (deps.print ?? console.log)(`rolled back ${name} to ${response.version}`);
}

export async function disableCommand(parsed: ParsedArgs, deps: CommandDeps = {}): Promise<void> {
  const [name] = requirePositionals(parsed, 1, "functions disable <name>");
  const config = await configFrom(flagValues(parsed), deps);
  const response = await disable(config, name, fetchOptions(deps));
  (deps.print ?? console.log)(`disabled ${name}@${response.version}`);
}

export async function healthCommand(parsed: ParsedArgs, deps: CommandDeps = {}): Promise<void> {
  assertNoPositionals(parsed, "functions health");
  const config = await configFrom(flagValues(parsed), deps);
  const print = deps.print ?? console.log;
  const health = await getHealth(config, fetchOptions(deps));

  if (parsed.booleans.has("json")) {
    print(JSON.stringify(health, null, 2));
    return;
  }

  const pool = Object.entries(health.pool)
    .map(([name, value]) => `${name}=${value}`)
    .join(" ");
  print(`pool\t${pool}`);

  if (health.storage !== "ok") print("storage\tunavailable");

  for (const fn of health.functions) {
    print(
      [
        fn.name,
        fn.version,
        `invocations=${fn.invocations ?? 0}`,
        `errors=${fn.errors ?? 0}`,
        `timeouts=${fn.timeouts ?? 0}`,
        `worker_kills=${fn.worker_kills ?? 0}`,
        `fetch_calls=${fn.fetch_calls ?? 0}`,
      ].join("\t"),
    );
  }
}

export async function typesCommand(parsed: ParsedArgs, deps: CommandDeps = {}): Promise<void> {
  assertNoPositionals(parsed, "functions types");
  const config = await configFrom(flagValues(parsed), deps);
  const path = await writeTypes(config);
  (deps.print ?? console.log)(`wrote ${relative(config.cwd, path) || basename(path)}`);
}

async function appsCommand(argv: string[], deps: CommandDeps): Promise<number> {
  const subcommand = argv[0];

  if (subcommand === undefined) {
    throw new UsageError("an apps subcommand is required");
  }

  const rest = argv.slice(1);
  switch (subcommand) {
    case "list":
      await appsListCommand(parse(rest, ["url", "token", "config"], ["json"]), deps);
      return 0;
    case "add":
      await appsAddCommand(parse(rest, ["url", "token", "config"], [], ["origin"]), deps);
      return 0;
    case "remove":
      await appsRemoveCommand(parse(rest, ["url", "token", "config"], []), deps);
      return 0;
    case "origin":
      return appsOriginCommand(rest, deps);
    default:
      throw new UsageError(`unknown apps command ${JSON.stringify(subcommand)}`);
  }
}

async function appsOriginCommand(argv: string[], deps: CommandDeps): Promise<number> {
  const subcommand = argv[0];

  if (subcommand === undefined) {
    throw new UsageError("an apps origin subcommand is required");
  }

  const rest = argv.slice(1);
  switch (subcommand) {
    case "add":
      await appOriginAddCommand(parse(rest, ["url", "token", "config"], []), deps);
      return 0;
    case "remove":
      await appOriginRemoveCommand(parse(rest, ["url", "token", "config"], []), deps);
      return 0;
    default:
      throw new UsageError(`unknown apps origin command ${JSON.stringify(subcommand)}`);
  }
}

export async function appsListCommand(parsed: ParsedArgs, deps: CommandDeps = {}): Promise<void> {
  assertNoPositionals(parsed, "apps list");
  const config = await configFrom(flagValues(parsed), deps);
  const response = await listApps(config, fetchOptions(deps));
  const print = deps.print ?? console.log;
  const apps = [...response.apps].sort(compareApps);

  if (parsed.booleans.has("json")) {
    const json = apps.map((app) => ({
      id: app.id,
      name: app.name,
      origins: app.origins,
      created_at: app.created_at,
    }));
    print(JSON.stringify({ apps: json }, null, 2));
    return;
  }

  for (const app of apps) {
    print([app.name, app.id, app.origins.join(","), app.created_at].join("\t"));
  }
}

/**
 * Registers an app, or the origins it is missing, without duplicating work.
 *
 * The server rejects a duplicate name, so the CLI looks first: an app with the
 * same exact name is extended with only the origins it does not have, and a
 * request that changes nothing is a successful no-op. A name that differs only
 * by case still goes to the server so its `duplicate_name` is what the operator
 * sees.
 *
 * Each missing origin is a separate request, so a conflict part-way leaves the
 * earlier additions registered; re-running resumes from the first missing one.
 */
export async function appsAddCommand(parsed: ParsedArgs, deps: CommandDeps = {}): Promise<void> {
  const [name] = requirePositionals(parsed, 1, "apps add <name> --origin <url>");
  const requested = parsed.lists.get("origin") ?? [];
  if (requested.length === 0) {
    throw new UsageError("apps add requires at least one --origin <url>");
  }

  const print = deps.print ?? console.log;
  const printError = deps.printError ?? console.error;
  const origins = [...new Set(requested.map(normalizeOrThrow))];
  for (const origin of origins) printWildcardWarning(origin, printError);

  const config = await configFrom(flagValues(parsed), deps);
  const existing = findApp((await listApps(config, fetchOptions(deps))).apps, name);

  if (existing === undefined || existing.name !== name) {
    const created = await createApp(config, name, origins, fetchOptions(deps));
    print(`added ${created.app.name} (${created.app.id})`);
    return;
  }

  const missing = origins.filter((origin) => !existing.origins.includes(origin));
  if (missing.length === 0) {
    print(`unchanged ${existing.name} (${existing.id})`);
    return;
  }

  let app = existing;
  for (const origin of new Set(missing)) {
    app = (await addAppOrigin(config, app.id, origin, fetchOptions(deps))).app;
    print(`added ${origin} to ${app.name} (${app.id})`);
  }
}

export async function appsRemoveCommand(parsed: ParsedArgs, deps: CommandDeps = {}): Promise<void> {
  const [name] = requirePositionals(parsed, 1, "apps remove <name>");
  const config = await configFrom(flagValues(parsed), deps);
  const app = await resolveApp(config, name, deps);

  await removeApp(config, app.id, fetchOptions(deps));
  const print = deps.print ?? console.log;
  print(`removed ${app.name} (${app.id})`);
  printRevocationNote(print);
}

export async function appOriginAddCommand(
  parsed: ParsedArgs,
  deps: CommandDeps = {},
): Promise<void> {
  const [name, rawOrigin] = requirePositionals(parsed, 2, "apps origin add <name> <url>");
  const origin = normalizeOrThrow(rawOrigin);
  printWildcardWarning(origin, deps.printError ?? console.error);

  const config = await configFrom(flagValues(parsed), deps);
  const app = await resolveApp(config, name, deps);
  const updated = await addAppOrigin(config, app.id, origin, fetchOptions(deps));
  (deps.print ?? console.log)(`added ${origin} to ${updated.app.name} (${updated.app.id})`);
}

export async function appOriginRemoveCommand(
  parsed: ParsedArgs,
  deps: CommandDeps = {},
): Promise<void> {
  const [name, rawOrigin] = requirePositionals(parsed, 2, "apps origin remove <name> <url>");
  const origin = normalizeOrThrow(rawOrigin);

  const config = await configFrom(flagValues(parsed), deps);
  const app = await resolveApp(config, name, deps);
  const updated = await removeAppOrigin(config, app.id, origin, fetchOptions(deps));
  const print = deps.print ?? console.log;
  print(`removed ${origin} from ${updated.app.name} (${updated.app.id})`);
  printRevocationNote(print);
}

function findApp(apps: readonly App[], name: string): App | undefined {
  const key = name.toLowerCase();
  return apps.find((app) => app.name.toLowerCase() === key);
}

async function resolveApp(config: ResolvedConfig, name: string, deps: CommandDeps): Promise<App> {
  const app = findApp((await listApps(config, fetchOptions(deps))).apps, name);
  if (app === undefined) throw new Error(`no app named ${JSON.stringify(name)}`);
  return app;
}

function normalizeOrThrow(raw: string): string {
  const origin = normalizeOrigin(raw);
  if (origin === undefined) {
    throw new UsageError(
      `invalid origin ${JSON.stringify(raw)}: use an http(s) origin with no path, query, or fragment`,
    );
  }
  return origin;
}

function printWildcardWarning(origin: string, printError: (line: string) => void): void {
  if (!isWildcardOrigin(origin)) return;
  printError(
    `warning: ${origin} is a wildcard origin and admits every matching subdomain; prefer exact origins`,
  );
}

function printRevocationNote(print: (line: string) => void): void {
  print(
    "revoked origins stop being admitted when the browser preflight cache expires (up to 300s)",
  );
}

function compareApps(left: App, right: App): number {
  if (left.name !== right.name) return left.name < right.name ? -1 : 1;
  if (left.id !== right.id) return left.id < right.id ? -1 : 1;
  return 0;
}

async function functionsCommand(argv: string[], deps: CommandDeps): Promise<number> {
  const subcommand = argv[0];

  if (subcommand === undefined) {
    throw new UsageError("a functions subcommand is required");
  }

  const rest = argv.slice(1);
  switch (subcommand) {
    case "list":
      await listCommand(parse(rest, ["url", "actor", "config"], []), deps);
      return 0;
    case "activate":
      await activateCommand(parse(rest, ["url", "token", "config"], []), deps);
      return 0;
    case "rollback":
      await rollbackCommand(parse(rest, ["url", "token", "config"], []), deps);
      return 0;
    case "disable":
      await disableCommand(parse(rest, ["url", "token", "config"], []), deps);
      return 0;
    case "health":
      await healthCommand(parse(rest, ["url", "token", "config"], ["json"]), deps);
      return 0;
    case "types":
      await typesCommand(parse(rest, ["config"], []), deps);
      return 0;
    default:
      throw new UsageError(`unknown functions command ${JSON.stringify(subcommand)}`);
  }
}

/**
 * Watches `functions/` and redeploys changed entries. The initial pass deploys
 * everything, then each debounced batch deploys only the changed files. The
 * returned function stops the watcher; the caller keeps the process alive.
 */
export async function watchFunctions(options: WatchFunctionsOptions = {}): Promise<() => void> {
  const config =
    options.config ??
    (await loadConfig(options.cwd ?? process.cwd(), {
      config: options.configPath,
      url: options.url,
      token: options.token,
      actor: options.actor,
    }));
  const print = options.print ?? console.log;
  const printError = options.printError ?? console.error;

  // `pnpm dev` runs this pane for every project, including one with no
  // functions yet. An absent directory is an idle pane, not a crashed
  // process that takes the server and app down with it.
  if (!existsSync(config.functions.dir)) {
    print(`no functions directory at ${config.functions.dir}; not watching`);
    return () => {};
  }

  const deployAll = options.deployAll ?? deployEntries;
  const deployChanged = options.deployChanged ?? deployFiles;
  const debounceMs = options.debounceMs ?? 150;
  const deployOptions: DeployOptionsForWatcher = {
    cwd: config.cwd,
    config,
    writeTypes: false,
    fetchImpl: options.fetchImpl,
    print,
  };

  const regenerateMap = async (): Promise<void> => {
    try {
      await writeTypes(config);
    } catch (error) {
      printError(`contract map failed: ${messageOf(error)}`);
    }
  };

  const pass = async (deploy: () => Promise<DeployResult>): Promise<void> => {
    try {
      await deploy();
    } catch (error) {
      printError(`deploy failed: ${messageOf(error)}`);
    }
    await regenerateMap();
  };

  await pass(() => deployAll(deployOptions));

  let timer: ReturnType<typeof setTimeout> | undefined;
  let queue = Promise.resolve();
  const pending = new Set<string>();

  const watcher = watch(config.functions.dir, { recursive: true }, (_event, filename) => {
    if (filename === null) return;
    const path = resolve(config.functions.dir, filename.toString());
    if (!isEntryFile(path)) return;

    pending.add(path);
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      const changed = [...pending].sort();
      pending.clear();
      queue = queue.then(() => pass(() => deployChanged(changed, deployOptions)));
    }, debounceMs);
  });

  watcher.on("error", (error) => printError(`watch failed: ${messageOf(error)}`));

  const close = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    pending.clear();
    watcher.close();
    options.signal?.removeEventListener("abort", close);
  };

  if (options.signal?.aborted) close();
  else options.signal?.addEventListener("abort", close, { once: true });

  return close;
}

export async function devCommand(
  options: Omit<WatchFunctionsOptions, "config"> = {},
  deps: CommandDeps = {},
): Promise<void> {
  await watchFunctions({ ...options, ...deps, cwd: options.cwd ?? deps.cwd });
}

function configFrom(
  values: Record<string, string | undefined>,
  deps: CommandDeps,
): Promise<ResolvedConfig> {
  const options: LoadConfigOptions = {
    config: values.config,
    url: values.url,
    token: values.token,
    actor: values.actor,
  };
  return loadConfig(deps.cwd ?? process.cwd(), options);
}

function fetchOptions(deps: CommandDeps): { fetchImpl?: FetchLike } {
  return deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl };
}

function flagValues(parsed: ParsedArgs): Record<string, string | undefined> {
  return {
    url: parsed.values.get("url"),
    token: parsed.values.get("token"),
    actor: parsed.values.get("actor"),
    config: parsed.values.get("config"),
  };
}

function parse(
  argv: readonly string[],
  valueFlags: readonly string[],
  booleanFlags: readonly string[],
  listFlags: readonly string[] = [],
): ParsedArgs {
  const values = new Map<string, string>();
  const lists = new Map<string, string[]>();
  const booleans = new Set<string>();
  const positionals: string[] = [];
  const valueNames = new Set(valueFlags);
  const booleanNames = new Set(booleanFlags);
  const listNames = new Set(listFlags);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;

    if (arg === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }

    if (!arg.startsWith("-")) {
      positionals.push(arg);
      continue;
    }

    const [flag, inline] = splitFlag(arg);
    const name = flag.slice(2);

    if (valueNames.has(name) || listNames.has(name)) {
      const value = inline ?? argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new UsageError(`--${name} requires a value`);
      }
      if (listNames.has(name)) {
        lists.set(name, [...(lists.get(name) ?? []), value]);
      } else {
        values.set(name, value);
      }
      if (inline === undefined) index += 1;
    } else if (booleanNames.has(name) && inline === undefined) {
      booleans.add(name);
    } else {
      throw new UsageError(`unknown option ${JSON.stringify(arg)}`);
    }
  }

  return { positionals, values, lists, booleans };
}

function splitFlag(arg: string): [string, string | undefined] {
  const equals = arg.indexOf("=");
  if (equals === -1) return [arg, undefined];
  return [arg.slice(0, equals), arg.slice(equals + 1)];
}

function assertNoPositionals(parsed: ParsedArgs, command: string): void {
  if (parsed.positionals.length > 0) {
    throw new UsageError(`${command} does not take positional arguments`);
  }
}

function requirePositionals(parsed: ParsedArgs, count: number, usage: string): string[] {
  if (parsed.positionals.length !== count) {
    throw new UsageError(`usage: ebb ${usage}`);
  }
  return parsed.positionals;
}
