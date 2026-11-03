import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FunctionBundleError, bundleFunction, bundleSource, definitionName } from "./bundle.ts";
import { digestFor, validateEnvelope, type FunctionEnvelope } from "./envelope.ts";

const validSource = `
const defineFunction = (schema, handler) => ({ schema, handler });
const p = { object: (shape) => ({ type: "object", properties: shape }) };
export const proofreadDocument = defineFunction(p.object({ id: p.string }), async (ctx, params) => {
  const entity = await ctx.get(params.id);
  return { title: entity?.data.fields.title ?? null };
});
`;

describe("bundleFunction", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ebb-cli-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const writeEntry = async (source: string): Promise<string> => {
    const path = join(dir, "entry.ts");
    await writeFile(path, source, "utf8");
    return path;
  };

  it("writes the IIFE beside an envelope whose digest covers the code", async () => {
    const entryPath = await writeEntry(validSource);
    const result = await bundleFunction({ entryPath, outDir: dir, version: "1.0.0" });

    expect(result.name).toBe("proofreadDocument");
    expect(result.codePath).toBe(join(dir, "proofreadDocument@1.0.0.js"));
    expect(result.envelopePath).toBe(join(dir, "proofreadDocument@1.0.0.envelope.json"));

    const code = await readFile(result.codePath, "utf8");
    const envelope = JSON.parse(await readFile(result.envelopePath, "utf8")) as FunctionEnvelope;

    expect(code).toContain("__ebbFunction");
    expect(envelope.digest).toBe(digestFor(code));
    expect(envelope.entry).toBe("proofreadDocument");
    expect(envelope.contract).toBe(1);
    expect(envelope.access).toBe("granted");
    expect(envelope.paramsSchema).toBeUndefined();
    expect(validateEnvelope(envelope)).toEqual([]);
  });

  it("runs the bundled IIFE and exposes the exported binding", async () => {
    const entryPath = await writeEntry(`
      const defineFunction = (schema, handler) => handler;
      export const echo = defineFunction({}, (ctx, params) => ({ params, actor: ctx.actor.id }));
    `);
    const result = await bundleFunction({ entryPath, outDir: dir, version: "1.0.0" });

    const factory = new Function(`${result.code}\nreturn __ebbFunction;`) as () => Record<
      string,
      unknown
    >;
    const exports = factory();
    const handler = exports.echo as (ctx: unknown, params: unknown) => unknown;

    expect(handler({ actor: { id: "a_test" } }, { hello: "world" })).toEqual({
      params: { hello: "world" },
      actor: "a_test",
    });
  });

  it("rejects a node: import at bundle time", async () => {
    await expect(
      bundleSource(
        `import { readFile } from "node:fs/promises";
         export const reads = async (ctx) => readFile("/etc/passwd", "utf8");`,
        join(dir, "entry.ts"),
        "reads",
      ),
    ).rejects.toThrow(/node: imports are not allowed/);
  });

  it("rejects a bare Node builtin at bundle time", async () => {
    await expect(
      bundleSource(
        `import { readFile } from "fs/promises";
         export const reads = async (ctx) => readFile("/etc/passwd", "utf8");`,
        join(dir, "entry.ts"),
        "reads",
      ),
    ).rejects.toThrow(/Node built-in imports are not allowed/);
  });

  it("rejects export default and multiple definitions", async () => {
    const entryPath = await writeEntry(`
      ${validSource}
      export const second = defineFunction(p.object({}), () => 1);
    `);

    await expect(bundleFunction({ entryPath, outDir: dir, version: "1.0.0" })).rejects.toThrow(
      /exactly one/,
    );

    const defaultPath = await writeEntry(`
      export default defineFunction(p.object({}), () => 1);
    `);
    await expect(
      bundleFunction({ entryPath: defaultPath, outDir: dir, version: "1.0.0" }),
    ).rejects.toThrow(/export default/);
  });

  it("rejects a name longer than 64 characters", async () => {
    const longName = `a${"b".repeat(64)}`;
    const entryPath = await writeEntry(`
      export const ${longName} = defineFunction(p.object({}), () => 1);
    `);
    await expect(bundleFunction({ entryPath, outDir: dir, version: "1.0.0" })).rejects.toThrow(
      FunctionBundleError,
    );
  });
});

describe("definitionName", () => {
  it("reads the exported binding name and tolerates a type annotation", () => {
    expect(definitionName("export const hello = defineFunction(x, y);")).toBe("hello");
    expect(
      definitionName(
        "export const hello: FunctionDef<unknown, void, number> = defineFunction(x, y);",
      ),
    ).toBe("hello");
  });
});
