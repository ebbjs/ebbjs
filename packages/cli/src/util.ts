import { basename, relative } from "node:path";

export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const isMissingFile = (error: unknown): boolean =>
  isRecord(error) && error.code === "ENOENT";

export const toPosix = (path: string): string => path.replaceAll("\\", "/");

/** The path a message shows, relative to the project the command runs in. */
export const displayPath = (cwd: string, path: string): string => toPosix(relative(cwd, path));

/**
 * A deploy entry is a TypeScript file. Declaration and test files sit beside
 * entries in the same tree but are not deployable.
 */
export function isEntryFile(path: string): boolean {
  const name = basename(path);
  return name.endsWith(".ts") && !name.endsWith(".d.ts") && !name.endsWith(".test.ts");
}
