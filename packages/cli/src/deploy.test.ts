import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { digestFor } from "./envelope.ts";
import { deploymentHashFor } from "./deployment-hash.ts";
import { deployEntries, prepareDeployment, type DeployOptions } from "./deploy.ts";
import {
  jsonResponse,
  jsonBody,
  recordingFetch,
  removeProject,
  tempProject,
  type FetchCall,
} from "./test-utils.ts";

const version = "2026-10-23T12:00:00.000Z";
const functionName = "proofreadDocument";

/** GET `/versions` is history; POST `/versions` is an upload. */
const isHistory = (call: FetchCall): boolean =>
  call.url.endsWith("/versions") && (call.init.method ?? "GET") === "GET";

const noHistory = () => jsonResponse(404, { error: "not_found", details: "no versions" });

const functionSource = `
  import { defineFunction, p } from "@ebbjs/server";

  export const ${functionName} = defineFunction(
    {},
    p.object({ documentId: p.string() }),
    async (_ctx, params) => ({ count: params.documentId.length }),
    {
      access: "authenticated",
      timeoutMs: 5000,
      memoryMb: 64,
      output: p.object({ count: p.number() }),
    },
  );
`;

describe("deployEntries", () => {
  const projects: string[] = [];

  const project = async (): Promise<string> => {
    const dir = await tempProject("deploy-");
    projects.push(dir);
    await mkdir(join(dir, "functions"), { recursive: true });
    await writeFile(join(dir, "functions", `${functionName}.ts`), functionSource, "utf8");
    return dir;
  };

  afterEach(async () => {
    await Promise.all(projects.splice(0).map(removeProject));
  });

  const uploadAwareFetch = (name = functionName) =>
    recordingFetch((call) => {
      if (isHistory(call)) return noHistory();
      if (call.url.endsWith("/versions")) {
        return jsonResponse(201, { ok: true, name, version, status: "retired", pinned: false });
      }
      if (call.url.endsWith("/activate")) {
        return jsonResponse(200, { ok: true, name, version, status: "active" });
      }
      if (call.url.endsWith("/functions")) {
        return jsonResponse(200, { functions: [] });
      }
      throw new Error(`unexpected request ${call.url}`);
    });

  /** A server that already knows `versions` for this name. */
  const fetchWithHistory = (versions: readonly Record<string, unknown>[]) =>
    recordingFetch((call) => {
      if (isHistory(call)) return jsonResponse(200, { versions });
      if (call.url.endsWith("/versions")) {
        return jsonResponse(201, {
          ok: true,
          name: functionName,
          version,
          status: "retired",
          pinned: false,
        });
      }
      if (call.url.endsWith("/activate")) {
        return jsonResponse(200, {
          ok: true,
          name: functionName,
          version,
          status: "active",
        });
      }
      return jsonResponse(200, { functions: [] });
    });

  const historyEntry = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    version,
    status: "active",
    createdAt: 1,
    activatedAt: 1,
    pinned: false,
    createdBy: null,
    ...overrides,
  });

  /** The hash this checkout would send, without going over the network. */
  const hashOfEntry = async (cwd: string): Promise<string> => {
    const prepared = await prepareDeployment(join(cwd, "functions", `${functionName}.ts`), {
      version,
    });
    return deploymentHashFor(prepared.envelope);
  };

  const uploadsOf = (calls: readonly FetchCall[]) =>
    calls.filter((call) => call.url.endsWith("/versions") && !isHistory(call));

  const uploadBody = (call: FetchCall): Record<string, unknown> => jsonBody(call);

  it("uploads the definition's envelope, activates it, and prints the grant", async () => {
    const cwd = await project();
    const { fetchImpl, calls } = uploadAwareFetch();
    const lines: string[] = [];

    await deployEntries({
      cwd,
      url: "http://localhost:4001",
      token: "admin-token",
      version,
      fetchImpl,
      print: (line) => lines.push(line),
    });

    const upload = uploadsOf(calls)[0]!;
    const body = uploadBody(upload);
    const envelope = body.envelope as Record<string, unknown>;

    expect(upload.init.method).toBe("POST");
    expect(upload.url).toBe(`http://localhost:4001/functions/${functionName}/versions`);
    expect(new Headers(upload.init.headers).get("authorization")).toBe("Bearer admin-token");
    expect(body.code).toBeTypeOf("string");
    expect(body.pinned).toBe(false);
    expect(String(body.deploymentHash)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(envelope.name).toBe(functionName);
    expect(envelope.entry).toBe(functionName);
    expect(envelope.access).toBe("authenticated");
    expect(envelope.timeoutMs).toBe(5000);
    expect(envelope.memoryBytes).toBe(64 * 1024 * 1024);
    expect(envelope.digest).toBe(digestFor(String(body.code)));
    expect(envelope.paramsSchema).toMatchObject({
      type: "object",
      properties: { documentId: { type: "string" } },
    });
    expect(envelope.outputSchema).toMatchObject({
      type: "object",
      properties: { count: { type: "number" } },
    });

    // The exact shape the runner evaluates: `{ <entry>: definition }`, with
    // the schema and handler on the definition.
    const exports = new Function(`${String(body.code)}\nreturn __ebbFunction;`)() as Record<
      string,
      { schema?: unknown; handler?: unknown }
    >;
    expect(exports[functionName]?.schema).toBeDefined();
    expect(exports[functionName]?.handler).toBeTypeOf("function");

    expect(calls.some((call) => call.url.endsWith("/activate"))).toBe(true);
    expect(lines).toContain(`deployed ${functionName}@${version}`);
    expect(lines).toContain(`activated ${functionName}@${version}`);
    expect(lines).toContain(`grant function.${functionName}`);
    expect(lines).toContain("drift check skipped: no actor credential in ebb.config.ts");
  });

  it("keys the upload and contract map by the exported name, not the file name", async () => {
    const cwd = await tempProject("deploy-renamed-");
    projects.push(cwd);
    await mkdir(join(cwd, "functions"), { recursive: true });
    await writeFile(
      join(cwd, "functions", "wrongFile.ts"),
      `
        import { defineFunction, p } from "@ebbjs/server";

        export const realName = defineFunction(
          {},
          p.object({}),
          async () => ({ ok: true }),
        );
      `,
      "utf8",
    );

    const { fetchImpl, calls } = uploadAwareFetch("realName");

    await deployEntries({
      cwd,
      token: "admin-token",
      version,
      fetchImpl,
      print: () => {},
    });

    expect(uploadsOf(calls)[0]!.url).toBe(`http://localhost:4000/functions/realName/versions`);

    const generated = await readFile(join(cwd, "src/ebb-functions.generated.ts"), "utf8");
    expect(generated).toContain('import type { realName } from "../functions/wrongFile";');
    expect(generated).toContain('realName: functionContract<typeof realName>("realName")');
    expect(generated).not.toContain("wrongFile:");
  });

  it("leaves the active pointer alone with --no-activate", async () => {
    const cwd = await project();
    const { fetchImpl, calls } = uploadAwareFetch();
    const lines: string[] = [];

    await deployEntries({
      cwd,
      token: "admin-token",
      version,
      activate: false,
      fetchImpl,
      print: (line) => lines.push(line),
    });

    expect(uploadsOf(calls)).toHaveLength(1);
    expect(calls.some((call) => call.url.endsWith("/activate"))).toBe(false);
    expect(lines).toContain(`left ${functionName} active version unchanged`);
  });

  it("pins the upload with --keep", async () => {
    const cwd = await project();
    const { fetchImpl, calls } = uploadAwareFetch();

    await deployEntries({
      cwd,
      token: "admin-token",
      version,
      keep: true,
      fetchImpl,
      print: () => {},
    });

    const upload = uploadsOf(calls)[0]!;
    expect(uploadBody(upload).pinned).toBe(true);
  });

  it("lets --url and --token override ebb.config.ts", async () => {
    const cwd = await project();
    await writeFile(
      join(cwd, "ebb.config.ts"),
      `export default { url: "http://wrong", token: "wrong" };`,
      "utf8",
    );
    const { fetchImpl, calls } = uploadAwareFetch();

    await deployEntries({
      cwd,
      url: "http://right:4100",
      token: "right-token",
      version,
      fetchImpl,
      print: () => {},
    });

    const upload = uploadsOf(calls)[0]!;
    expect(upload.url).toBe(`http://right:4100/functions/${functionName}/versions`);
    expect(new Headers(upload.init.headers).get("authorization")).toBe("Bearer right-token");
  });

  it("warns about contract-map drift when an actor is configured", async () => {
    const cwd = await project();
    const { fetchImpl } = recordingFetch((call) => {
      if (isHistory(call)) return noHistory();
      if (call.url.endsWith("/versions")) {
        return jsonResponse(201, {
          ok: true,
          name: functionName,
          version,
          status: "retired",
          pinned: false,
        });
      }
      if (call.url.endsWith("/activate")) {
        return jsonResponse(200, { ok: true, name: functionName, version, status: "active" });
      }
      return jsonResponse(200, {
        functions: [{ name: "deployedOnly", version, access: "granted" }],
      });
    });
    const lines: string[] = [];

    await deployEntries({
      cwd,
      token: "admin-token",
      actor: "a_author",
      version,
      fetchImpl,
      print: (line) => lines.push(line),
    });

    expect(lines).toContain("warning: contract map drift");
    expect(lines).toContain("  missing: deployedOnly is deployed but has no local entry");
    expect(lines).toContain(`  extra: ${functionName} has a local entry but no deployed version`);
  });

  it("reports deployed functions that have no local entry as drift", async () => {
    const cwd = await project();
    const { fetchImpl } = recordingFetch((call) => {
      if (isHistory(call)) return noHistory();
      if (call.url.endsWith("/versions")) {
        return jsonResponse(201, {
          ok: true,
          name: functionName,
          version,
          status: "retired",
          pinned: false,
        });
      }
      if (call.url.endsWith("/activate")) {
        return jsonResponse(200, { ok: true, name: functionName, version, status: "active" });
      }
      return jsonResponse(200, {
        functions: [
          { name: functionName, version, access: "authenticated" },
          { name: "deployedOnly", version, access: "granted" },
        ],
      });
    });
    const lines: string[] = [];

    await deployEntries({
      cwd,
      token: "admin-token",
      actor: "a_author",
      version,
      fetchImpl,
      print: (line) => lines.push(line),
    });

    expect(lines).toContain("  missing: deployedOnly is deployed but has no local entry");
    expect(lines.some((line) => line.includes(`extra: ${functionName}`))).toBe(false);
  });

  const deployProject = async (
    cwd: string,
    fetchImpl: DeployOptions["fetchImpl"],
    extra: DeployOptions = {},
  ) => {
    const lines: string[] = [];
    const result = await deployEntries({
      cwd,
      token: "admin-token",
      version,
      fetchImpl,
      print: (line) => lines.push(line),
      ...extra,
    });
    return { result, lines };
  };

  it("skips the upload and activation when the active version is unchanged", async () => {
    const cwd = await project();
    const hash = await hashOfEntry(cwd);
    const { fetchImpl, calls } = fetchWithHistory([
      historyEntry({ version: "2026-10-01T00:00:00.000Z", deploymentHash: hash }),
    ]);

    const { result, lines } = await deployProject(cwd, fetchImpl, { actor: "a_author" });

    expect(uploadsOf(calls)).toHaveLength(0);
    expect(calls.some((call) => call.url.endsWith("/activate"))).toBe(false);
    expect(lines).toContain(`unchanged ${functionName}@2026-10-01T00:00:00.000Z`);
    expect(lines).not.toContain(`grant function.${functionName}`);

    const [deployed] = result.functions;
    expect(deployed!.unchanged).toBe(true);
    expect(deployed!.activated).toBe(false);
    expect(deployed!.version).toBe("2026-10-01T00:00:00.000Z");
    expect(deployed!.envelope.version).toBe("2026-10-01T00:00:00.000Z");

    // The map and the drift check are not deploy steps: they still run.
    expect(await readFile(join(cwd, "src/ebb-functions.generated.ts"), "utf8")).toContain(
      `functionContract<typeof ${functionName}>("${functionName}")`,
    );
    expect(lines).toContain(`  extra: ${functionName} has a local entry but no deployed version`);
  });

  it("uploads when a hashed envelope field changed", async () => {
    const cwd = await project();
    const prepared = await prepareDeployment(join(cwd, "functions", `${functionName}.ts`), {
      version,
    });
    const staleHash = deploymentHashFor({ ...prepared.envelope, access: "granted" });
    const { fetchImpl, calls } = fetchWithHistory([historyEntry({ deploymentHash: staleHash })]);

    const { result, lines } = await deployProject(cwd, fetchImpl);

    expect(uploadsOf(calls)).toHaveLength(1);
    expect(calls.some((call) => call.url.endsWith("/activate"))).toBe(true);
    expect(lines).toContain(`deployed ${functionName}@${version}`);
    expect(lines).toContain(`activated ${functionName}@${version}`);
    expect(result.functions[0]!.unchanged).toBe(false);
  });

  it("uploads and activates with --force even when the version exists", async () => {
    const cwd = await project();
    const hash = await hashOfEntry(cwd);
    const { fetchImpl, calls } = fetchWithHistory([historyEntry({ deploymentHash: hash })]);

    const { result, lines } = await deployProject(cwd, fetchImpl, { force: true });

    expect(uploadsOf(calls)).toHaveLength(1);
    expect(calls.some((call) => call.url.endsWith("/activate"))).toBe(true);
    expect(lines).toContain(`deployed ${functionName}@${version}`);
    expect(result.functions[0]!.unchanged).toBe(false);
  });

  it("uploads a new pinned version with --keep even when the version exists", async () => {
    const cwd = await project();
    const hash = await hashOfEntry(cwd);
    const { fetchImpl, calls } = fetchWithHistory([historyEntry({ deploymentHash: hash })]);

    await deployProject(cwd, fetchImpl, { keep: true });

    const uploads = uploadsOf(calls);
    expect(uploads).toHaveLength(1);
    expect(uploadBody(uploads[0]!).pinned).toBe(true);
    expect(calls.some((call) => call.url.endsWith("/activate"))).toBe(true);
  });

  it("leaves the pointer alone with --no-activate when the version exists", async () => {
    const cwd = await project();
    const hash = await hashOfEntry(cwd);
    const { fetchImpl, calls } = fetchWithHistory([
      historyEntry({ version: "2026-10-01T00:00:00.000Z", deploymentHash: hash }),
    ]);

    const { lines } = await deployProject(cwd, fetchImpl, { activate: false });

    expect(uploadsOf(calls)).toHaveLength(0);
    expect(calls.some((call) => call.url.endsWith("/activate"))).toBe(false);
    expect(lines).toContain(`unchanged ${functionName}@2026-10-01T00:00:00.000Z`);
    expect(lines.some((line) => line.startsWith("activated "))).toBe(false);
    expect(lines.some((line) => line.startsWith("left "))).toBe(false);
  });

  it("activates the newest matching version when the active one differs", async () => {
    const cwd = await project();
    const hash = await hashOfEntry(cwd);
    const newest = "2026-11-02T00:00:00.000Z";
    const { fetchImpl, calls } = fetchWithHistory([
      historyEntry({
        version: newest,
        status: "retired",
        createdAt: 3,
        activatedAt: null,
        deploymentHash: hash,
      }),
      historyEntry({
        version: "2026-11-01T00:00:00.000Z",
        status: "retired",
        createdAt: 2,
        activatedAt: null,
        deploymentHash: hash,
      }),
      historyEntry({
        version: "2026-10-01T00:00:00.000Z",
        createdAt: 1,
        deploymentHash: `sha256:${"0".repeat(64)}`,
      }),
    ]);

    const { result, lines } = await deployProject(cwd, fetchImpl);

    expect(uploadsOf(calls)).toHaveLength(0);
    const activates = calls.filter((call) => call.url.endsWith("/activate"));
    expect(activates).toHaveLength(1);
    expect(jsonBody(activates[0]!)).toEqual({ version: newest });
    expect(lines).toContain(`unchanged ${functionName}@${newest}`);
    expect(lines).toContain(`activated ${functionName}@${newest}`);
    expect(result.functions[0]!.activated).toBe(true);
  });

  it("uploads when the name has no version history", async () => {
    const cwd = await project();
    const { fetchImpl, calls } = uploadAwareFetch();

    const { lines } = await deployProject(cwd, fetchImpl);

    expect(calls.filter(isHistory)).toHaveLength(1);
    expect(uploadsOf(calls)).toHaveLength(1);
    expect(lines).toContain(`deployed ${functionName}@${version}`);
  });

  it("keeps the active duplicate rather than activating a newer one", async () => {
    const cwd = await project();
    const hash = await hashOfEntry(cwd);
    const { fetchImpl, calls } = fetchWithHistory([
      historyEntry({ status: "retired", createdAt: 2, activatedAt: null, deploymentHash: hash }),
      historyEntry({
        version: "2026-10-01T00:00:00.000Z",
        createdAt: 1,
        deploymentHash: hash,
      }),
    ]);

    const { result, lines } = await deployProject(cwd, fetchImpl);

    expect(uploadsOf(calls)).toHaveLength(0);
    expect(calls.some((call) => call.url.endsWith("/activate"))).toBe(false);
    expect(lines).toContain(`unchanged ${functionName}@2026-10-01T00:00:00.000Z`);
    expect(result.functions[0]!.activated).toBe(false);
  });

  it("surfaces a history read failure instead of redeploying", async () => {
    const cwd = await project();
    const { fetchImpl, calls } = recordingFetch((call) => {
      if (isHistory(call)) {
        return jsonResponse(500, { error: "internal_error", details: "the store is down" });
      }
      throw new Error(`unexpected request ${call.url}`);
    });

    await expect(deployProject(cwd, fetchImpl)).rejects.toThrow(/internal_error/);
    expect(uploadsOf(calls)).toHaveLength(0);
  });

  it("treats a quote, semicolon, and indent rewrite as the same deployment", async () => {
    const cwd = await project();
    const before = await hashOfEntry(cwd);
    const reformatted = `
      import { defineFunction, p } from '@ebbjs/server'

      export const ${functionName} = defineFunction(
        {},
        p.object({ documentId: p.string() }),
        async (_ctx, params) => ({ count: params.documentId.length }),
        {
          access: 'authenticated',
          timeoutMs: 5000,
          memoryMb: 64,
          output: p.object({ count: p.number() })
        }
      )
    `;

    await writeFile(join(cwd, "functions", `${functionName}.ts`), reformatted, "utf8");

    expect(await hashOfEntry(cwd)).toBe(before);
  });
});
