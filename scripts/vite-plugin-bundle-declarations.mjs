#!/usr/bin/env node
/**
 * Emits one self-contained `.d.ts` per published entry, bundling straight from
 * the TypeScript sources.
 *
 * `vite` bundles the runtime, so the declarations have to be bundled to match:
 * per-module declarations are linked by relative specifiers, which a `node16`
 * consumer cannot resolve under `moduleResolution: "bundler"` output. Emitting
 * them first and re-bundling afterwards would only generate a tree to delete, so
 * this replaces `vite-plugin-dts` for the published packages. See
 * docs/tooling/releasing.md.
 *
 * Entries come from the package's own `exports`/`types` targets, so a new
 * subpath needs no configuration here. Runs in `closeBundle`, which fires on
 * every rebuild of `vite build --watch` as well, keeping the dev artifacts the
 * same shape as a release build.
 */
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { rollup } from "rollup";
import { dts } from "rollup-plugin-dts";

// A declaration that reaches a sibling module by relative path, or a sourcemap
// comment pointing at sources the package does not ship, defeats the purpose.
const RELATIVE_SPECIFIER = /(\bfrom\s*|\bimport\(\s*)(["'])(\.[^"']*)\2/;
const SOURCE_MAP_COMMENT = /\/\/#\s*sourceMappingURL=/;

const exists = (path) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** Files under `dir` whose name matches `pattern`. */
const matchingFiles = async (dir, pattern) => {
  if (!(await exists(dir))) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => matchingFiles(join(dir, entry.name), pattern)),
  );
  return [
    ...entries
      .filter((entry) => entry.isFile() && pattern.test(entry.name))
      .map((entry) => join(dir, entry.name)),
    ...nested.flat(),
  ];
};

/**
 * Every published entry as `{ declaration, source }`, derived from the
 * manifest. The declared `dist` path is the artifact; the source is the same
 * subpath under `src`, which is what gets bundled.
 */
const publishedEntries = async (packageDir, manifest) => {
  const declarations = new Set();
  const walk = (value) => {
    if (typeof value === "string") {
      if (value.endsWith(".d.ts")) declarations.add(value.replace(/^\.\//, ""));
    } else if (value && typeof value === "object") {
      for (const nested of Object.values(value)) walk(nested);
    }
  };
  walk(manifest.exports);
  walk(manifest.types);

  const entries = [];
  for (const declaration of declarations) {
    if (!declaration.startsWith("dist/")) {
      throw new Error(`${manifest.name}: ${declaration} is outside dist/`);
    }
    const source = declaration.replace(/^dist\//, "src/").replace(/\.d\.ts$/, ".ts");
    const sourcePath = resolve(packageDir, source);
    if (!(await exists(sourcePath))) {
      throw new Error(`${manifest.name}: ${declaration} has no source at ${source}`);
    }
    entries.push({ declaration: resolve(packageDir, declaration), source: sourcePath });
  }
  if (entries.length === 0) throw new Error(`${manifest.name}: the manifest declares no entries`);
  return entries.sort((left, right) => left.declaration.localeCompare(right.declaration));
};

const bundle = async ({ declaration, source }) => {
  const build = await rollup({
    input: source,
    external: (id) => !id.startsWith(".") && !isAbsolute(id),
    plugins: [dts()],
    onwarn: (warning, warn) => {
      if (warning.code === "CIRCULAR_DEPENDENCY") return;
      warn(warning);
    },
  });
  const { output } = await build.generate({ format: "es", sourcemap: false });
  await build.close();
  if (output.length !== 1) throw new Error(`${source}: expected one chunk, got ${output.length}`);
  const [chunk] = output;
  if (RELATIVE_SPECIFIER.test(chunk.code)) {
    throw new Error(`${source}: bundled declaration still has a relative specifier`);
  }
  if (SOURCE_MAP_COMMENT.test(chunk.code)) {
    throw new Error(`${source}: bundled declaration still references a source map`);
  }

  await mkdir(join(declaration, ".."), { recursive: true });
  const staged = `${declaration}.bundling`;
  await writeFile(staged, chunk.code);
  await rename(staged, declaration);
};

/** The plugin: one declaration build per `vite build`, including watch rebuilds. */
export const bundleDeclarations = () => {
  let root = process.cwd();

  return {
    name: "ebb-bundle-declarations",
    apply: "build",
    configResolved(config) {
      root = config.root;
    },
    async closeBundle() {
      const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
      const entries = await publishedEntries(root, manifest);

      for (const entry of entries) await bundle(entry);

      // `dist` is not cleaned between builds, and older builds may have left
      // per-module declarations and declaration maps behind.
      const kept = new Set(entries.map((entry) => entry.declaration));
      const dist = join(root, "dist");
      const redundant = (await matchingFiles(dist, /\.d\.ts$/)).filter((file) => !kept.has(file));
      const staleMaps = await matchingFiles(dist, /\.d\.ts\.map$/);
      await Promise.all([...redundant, ...staleMaps].map((file) => rm(file, { force: true })));

      const names = entries.map((entry) => relative(dist, entry.declaration)).join(", ");
      console.log(
        `bundle-declarations: ${entries.length} entr${entries.length === 1 ? "y" : "ies"} (${names})` +
          (redundant.length + staleMaps.length > 0
            ? `, pruned ${redundant.length} declaration(s) and ${staleMaps.length} map(s)`
            : ""),
      );
    },
  };
};
