import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Plugin } from "esbuild";

import {
  CONTRACT_VERSION,
  DEFAULT_MEMORY_BYTES,
  DEFAULT_TIMEOUT_MS,
  buildEnvelope,
  codeFilename,
  digestFor,
  envelopeFilename,
  isValidFunctionName,
  validateEnvelope,
  type FunctionAccess,
  type FunctionEnvelope,
} from "./envelope.ts";

/** The global esbuild leaves the IIFE's exports on. The runner reads it. */
export const BUNDLE_GLOBAL_NAME = "__ebbFunction";

export interface BundleOptions {
  /** The file holding exactly one `export const <name> = defineFunction(...)`. */
  entryPath: string;
  /** Where `<name>@<version>.js` and its envelope are written. */
  outDir: string;
  version: string;
  access?: FunctionAccess;
  timeoutMs?: number;
  memoryBytes?: number;
  contract?: number;
  paramsSchema?: Record<string, unknown> | null;
  outputSchema?: Record<string, unknown> | null;
}

export interface BundleResult {
  name: string;
  version: string;
  code: string;
  codePath: string;
  envelopePath: string;
  envelope: FunctionEnvelope;
}

export class FunctionBundleError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(problems.join("\n"));
    this.name = "FunctionBundleError";
    this.problems = problems;
  }
}

/**
 * Bundles one function file and writes the IIFE code plus its envelope into
 * `outDir`. The exported binding name is the function name, route segment, and
 * permission suffix; there is no separate name option.
 */
export async function bundleFunction(options: BundleOptions): Promise<BundleResult> {
  const source = await readFile(options.entryPath, "utf8");
  const name = definitionName(source);

  if (!isValidFunctionName(name)) {
    throw new FunctionBundleError([
      `function name ${JSON.stringify(name)} is invalid: expected a JavaScript identifier of at most 64 characters`,
    ]);
  }

  const code = await bundleSource(source, options.entryPath, name);
  const digest = digestFor(code);

  const envelope = buildEnvelope({
    name,
    version: options.version,
    code,
    digest,
    contract: options.contract ?? CONTRACT_VERSION,
    access: options.access,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    memoryBytes: options.memoryBytes ?? DEFAULT_MEMORY_BYTES,
    entry: name,
    paramsSchema: options.paramsSchema,
    outputSchema: options.outputSchema,
  });

  const problems = validateEnvelope(envelope);
  if (problems.length > 0) {
    throw new FunctionBundleError(
      problems.map((problem) => `${problem.field}: ${problem.message}`),
    );
  }

  await mkdir(options.outDir, { recursive: true });

  const codePath = join(options.outDir, codeFilename(name, options.version));
  const envelopePath = join(options.outDir, envelopeFilename(name, options.version));

  await writeFile(codePath, code, "utf8");
  await writeFile(envelopePath, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");

  return { name, version: options.version, code, codePath, envelopePath, envelope };
}

/**
 * Bundles source that has already been read. Exported for tests and for a
 * future in-memory deploy path; the file API above is the normal one.
 */
export async function bundleSource(
  source: string,
  sourcefile: string,
  name = definitionName(source),
): Promise<string> {
  if (!isValidFunctionName(name)) {
    throw new FunctionBundleError([`function name ${JSON.stringify(name)} is invalid`]);
  }

  const result = await build({
    stdin: {
      contents: source,
      sourcefile,
      resolveDir: dirname(sourcefile),
      loader: loaderFor(sourcefile),
    },
    bundle: true,
    platform: "neutral",
    format: "iife",
    globalName: BUNDLE_GLOBAL_NAME,
    target: "es2022",
    // A function that exports its schema pulls in `@ebbjs/schema` and through
    // it `@ebbjs/core`. `neutral` alone drops the CommonJS `main` field and
    // the `browser` export condition, so `@msgpack/msgpack` (CJS `main` only)
    // would not resolve and `nanoid` would resolve to its `node:crypto` entry
    // — a builtin a portable bundle may not import. Bundles run in Bun, which
    // provides the browser Web Crypto and fetch surfaces these entries use.
    mainFields: ["module", "main"],
    conditions: ["browser"],
    write: false,
    logLevel: "silent",
    // The CLI's own install can supply the authoring SDK when the entry lives
    // somewhere without its own node_modules, such as a scratch directory.
    nodePaths: [resolve(dirname(fileURLToPath(import.meta.url)), "..", "node_modules")],
    plugins: [rejectNodeImports()],
  });

  return result.outputFiles[0]?.text ?? "";
}

function loaderFor(path: string): "ts" | "tsx" | "js" | "jsx" {
  if (path.endsWith(".tsx")) return "tsx";
  if (path.endsWith(".jsx")) return "jsx";
  if (path.endsWith(".js") || path.endsWith(".mjs") || path.endsWith(".cjs")) return "js";
  return "ts";
}

/**
 * The name of the single function definition in a source file.
 *
 * The export form is the contract: `export default` and files with more than
 * one definition are rejected rather than guessed at, because the binding is
 * also the route and the permission suffix.
 */
export function definitionName(source: string): string {
  const problems: string[] = [];

  if (/\bexport\s+default\b/.test(source)) {
    problems.push("`export default` is not supported; export one named binding instead");
  }

  const count = (source.match(/\bdefineFunction\s*(?:<[^>]*>)?\s*\(/g) ?? []).length;
  if (count === 0) {
    problems.push("no `defineFunction(...)` definition found");
  } else if (count > 1) {
    problems.push("a function file must contain exactly one `defineFunction(...)` definition");
  }

  const match = source.match(
    /\bexport\s+const\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=\n]+)?=\s*defineFunction\s*(?:<[^>]*>)?\s*\(/,
  );

  if (!match && count === 1) {
    problems.push("the definition must be exported as `export const <name> = defineFunction(...)`");
  }

  if (problems.length > 0) {
    throw new FunctionBundleError(problems);
  }

  return match![1]!;
}

/**
 * esbuild rejects `node:` imports and the older bare Node builtins at bundle
 * time, so a bundle that would not run in the runner never reaches a deploy.
 */
function rejectNodeImports(): Plugin {
  const nodeBuiltins = new Set([
    "assert",
    "buffer",
    "child_process",
    "cluster",
    "crypto",
    "dgram",
    "dns",
    "events",
    "fs",
    "http",
    "https",
    "net",
    "os",
    "path",
    "perf_hooks",
    "process",
    "readline",
    "stream",
    "string_decoder",
    "tls",
    "tty",
    "url",
    "util",
    "v8",
    "vm",
    "worker_threads",
    "zlib",
  ]);

  return {
    name: "ebb-reject-node-imports",
    setup(buildApi) {
      buildApi.onResolve({ filter: /^node:/ }, (args) => ({
        errors: [
          {
            text: `node: imports are not allowed in function bundles (${args.path})`,
          },
        ],
      }));

      buildApi.onResolve({ filter: /^[a-z_][a-z0-9_]*(\/.*)?$/ }, (args) => {
        const root = args.path.split("/")[0]!;
        if (nodeBuiltins.has(root)) {
          return {
            errors: [
              {
                text: `Node built-in imports are not allowed in function bundles (${args.path}); use fetch, streams, or an npm package instead`,
              },
            ],
          };
        }
        return null;
      });
    },
  };
}
