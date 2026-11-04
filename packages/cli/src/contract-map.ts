import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";

import { toPosix } from "./util.ts";

export interface ContractEntry {
  name: string;
  /** Absolute or cwd-relative path to the function's entry file. */
  path: string;
}

/** Accepts the entry shape used by deploy discovery, or a bare entry path. */
export type ContractEntryInput =
  | string
  | ContractEntry
  | { name: string; entryPath: string }
  | { name: string; path: string };

export interface RenderContractMapOptions {
  /** Base for relative entry paths. Defaults to process.cwd(). */
  cwd?: string;
  /** Header path to print instead of `typesOut`. */
  displayPath?: string;
}

export interface ContractDrift {
  /** Deployed names the generated map does not know about. */
  missing: string[];
  /** Generated names the server has no deployed version for. */
  extra: string[];
}

/**
 * Renders the client contract map. The runtime import is the only runtime
 * import; every function is a type-only import so a browser bundle never
 * carries the server authoring SDK.
 */
export function renderContractMap(
  entries: readonly ContractEntryInput[],
  typesOut: string,
  options: RenderContractMapOptions = {},
): string {
  const cwd = options.cwd ?? process.cwd();
  const normalized = entries.map((entry) => normalizeEntry(entry, cwd));
  const headerPath = toPosix(options.displayPath ?? typesOut);
  const sourceDir = dirname(resolve(cwd, typesOut));

  const lines = [
    `// ${headerPath} — emitted by \`ebb deploy\` / \`ebb functions types\``,
    'import { functionContract } from "@ebbjs/client";',
  ];

  for (const entry of normalized) {
    lines.push(`import type { ${entry.name} } from "${importSpecifier(sourceDir, entry.path)}";`);
  }

  lines.push("");

  if (normalized.length === 0) {
    lines.push("export const functions = {};");
  } else {
    lines.push("export const functions = {");
    for (const entry of normalized) {
      lines.push(`  ${entry.name}: functionContract<typeof ${entry.name}>("${entry.name}"),`);
    }
    lines.push("};");
  }

  return `${lines.join("\n")}\n`;
}

/**
 * The map is written even when there are no entries, so a stale file cannot
 * keep typing names the functions directory no longer declares.
 */
export async function writeContractMap(
  entries: readonly ContractEntryInput[],
  typesOut: string,
  options: RenderContractMapOptions = {},
): Promise<string> {
  const cwd = options.cwd ?? process.cwd();
  const path = resolve(cwd, typesOut);
  const output = renderContractMap(entries, typesOut, { ...options, cwd });

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, output, "utf8");
  return path;
}

/**
 * Compares the generated names with the deployed catalogue.
 *
 * A generated function missing from the server is `extra` (local-only), and a
 * deployed function missing from the map is `missing` (the client cannot type
 * it).
 */
export function checkDrift(
  entries: readonly ContractEntryInput[],
  deployedNames: readonly string[],
): ContractDrift {
  const generated = new Set(entries.map((entry) => entryName(entry)));
  const deployed = new Set(deployedNames);
  return {
    missing: [...deployed].filter((name) => !generated.has(name)).sort(),
    extra: [...generated].filter((name) => !deployed.has(name)).sort(),
  };
}

export function hasDrift(drift: ContractDrift): boolean {
  return drift.missing.length > 0 || drift.extra.length > 0;
}

function normalizeEntry(entry: ContractEntryInput, cwd: string): ContractEntry {
  if (typeof entry === "string") {
    return { name: nameFromPath(entry), path: resolve(cwd, entry) };
  }
  const path = "entryPath" in entry ? entry.entryPath : entry.path;
  return { name: entry.name, path: resolve(cwd, path) };
}

function entryName(entry: ContractEntryInput): string {
  return typeof entry === "string" ? nameFromPath(entry) : entry.name;
}

function nameFromPath(path: string): string {
  return basename(path).replace(/\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/, "");
}

function importSpecifier(fromDir: string, entryPath: string): string {
  const specifier = toPosix(relative(fromDir, entryPath)).replace(
    /\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/,
    "",
  );
  return specifier.startsWith(".") ? specifier : `./${specifier}`;
}
