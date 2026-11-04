import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { digestFor } from "./envelope.ts";
import { deployEntries } from "./deploy.ts";
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

  const uploadAwareFetch = () =>
    recordingFetch((call) => {
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
      if (call.url.endsWith("/functions")) {
        return jsonResponse(200, { functions: [] });
      }
      throw new Error(`unexpected request ${call.url}`);
    });

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

    const upload = calls.find((call) => call.url.endsWith("/versions"))!;
    const body = uploadBody(upload);
    const envelope = body.envelope as Record<string, unknown>;

    expect(upload.init.method).toBe("POST");
    expect(upload.url).toBe(`http://localhost:4001/functions/${functionName}/versions`);
    expect(new Headers(upload.init.headers).get("authorization")).toBe("Bearer admin-token");
    expect(body.code).toBeTypeOf("string");
    expect(body.pinned).toBe(false);
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

    expect(calls.some((call) => call.url.endsWith("/activate"))).toBe(true);
    expect(lines).toContain(`deployed ${functionName}@${version}`);
    expect(lines).toContain(`activated ${functionName}@${version}`);
    expect(lines).toContain(`grant function.${functionName}`);
    expect(lines).toContain("drift check skipped: no actor credential in ebb.config.ts");
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

    expect(calls.filter((call) => call.url.endsWith("/versions"))).toHaveLength(1);
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

    const upload = calls.find((call) => call.url.endsWith("/versions"))!;
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

    const upload = calls.find((call) => call.url.endsWith("/versions"))!;
    expect(upload.url).toBe(`http://right:4100/functions/${functionName}/versions`);
    expect(new Headers(upload.init.headers).get("authorization")).toBe("Bearer right-token");
  });

  it("warns about contract-map drift when an actor is configured", async () => {
    const cwd = await project();
    const { fetchImpl } = recordingFetch((call) => {
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
});
