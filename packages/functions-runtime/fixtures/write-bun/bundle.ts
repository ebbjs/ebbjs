/**
 * Bundles one fixture entry with `@ebbjs/cli`'s own esbuild configuration and
 * writes the IIFE to the given path.
 *
 * The Elixir write acceptance suite shells out to this script, so the code a
 * real Bun runner executes is produced by the builder a deploy uses — same
 * `bundle`/`platform`/`format`/`globalName`/`target`, same resolution, and the
 * same rejection of `node:` imports — rather than by a copy of those flags in
 * test code.
 */

import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";

import { bundleSource } from "../../../cli/src/bundle.ts";

const [entry, outfile] = process.argv.slice(2);

if (entry === undefined || outfile === undefined) {
  process.stderr.write("usage: bun bundle.ts <entry.ts> <outfile.js>\n");
  process.exit(64);
}

const name = basename(entry).replace(/\.ts$/, "");

try {
  const source = await readFile(entry, "utf8");
  await writeFile(outfile, await bundleSource(source, entry, name), "utf8");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
