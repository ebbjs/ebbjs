import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { main } from "./commands.ts";
import { prepareDeployment } from "./deploy.ts";
import { deploymentHashFor } from "./deployment-hash.ts";
import {
  jsonBody,
  jsonResponse,
  recordingFetch,
  removeProject,
  tempProject,
  type FetchCall,
} from "./test-utils.ts";

const requestHeaders = (call: FetchCall): Headers => new Headers(call.init.headers);

describe("commands", () => {
  const projects: string[] = [];

  const project = async (): Promise<string> => {
    const dir = await tempProject("commands-");
    projects.push(dir);
    return dir;
  };

  afterEach(async () => {
    await Promise.all(projects.splice(0).map(removeProject));
  });

  it("lists functions with the actor credential and prints the permission", async () => {
    const cwd = await project();
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse(200, {
        functions: [
          { name: "echo", version: "v1", access: "authenticated" },
          { name: "write", version: "v2", access: "granted" },
        ],
      }),
    );
    const lines: string[] = [];

    const code = await main(["functions", "list", "--url", "http://api.test", "--actor", "a_1"], {
      cwd,
      fetchImpl,
      print: (line) => lines.push(line),
    });

    expect(code).toBe(0);
    expect(calls[0]!.url).toBe("http://api.test/functions");
    expect(calls[0]!.init.method).toBe("GET");
    expect(requestHeaders(calls[0]!).get("x-ebb-actor-id")).toBe("a_1");
    expect(requestHeaders(calls[0]!).get("authorization")).toBeNull();
    expect(lines[0]).toContain("echo");
    expect(lines[0]).toContain("v1");
    expect(lines[0]).toContain("authenticated");
    expect(lines[0]).toContain("function.echo");
    expect(lines[1]).toContain("function.write");
  });

  it("activates a version with the admin token", async () => {
    const cwd = await project();
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse(200, { ok: true, name: "echo", version: "v2", status: "active" }),
    );

    const code = await main(
      ["functions", "activate", "echo", "v2", "--url", "http://api.test", "--token", "admin-token"],
      { cwd, fetchImpl, print: () => {} },
    );

    expect(code).toBe(0);
    expect(calls[0]!.url).toBe("http://api.test/functions/echo/activate");
    expect(calls[0]!.init.method).toBe("POST");
    expect(requestHeaders(calls[0]!).get("authorization")).toBe("Bearer admin-token");
    expect(jsonBody(calls[0]!)).toEqual({ version: "v2" });
  });

  it("rolls back with a bodyless POST", async () => {
    const cwd = await project();
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse(200, { ok: true, name: "echo", version: "v1", status: "active" }),
    );

    const code = await main(
      ["functions", "rollback", "echo", "--url", "http://api.test", "--token", "admin-token"],
      { cwd, fetchImpl, print: () => {} },
    );

    expect(code).toBe(0);
    expect(calls[0]!.url).toBe("http://api.test/functions/echo/rollback");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.body).toBeUndefined();
    expect(requestHeaders(calls[0]!).get("authorization")).toBe("Bearer admin-token");
  });

  it("disables a function with the admin token", async () => {
    const cwd = await project();
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse(200, { ok: true, name: "echo", version: "v2", status: "disabled" }),
    );

    const code = await main(
      ["functions", "disable", "echo", "--url", "http://api.test", "--token", "admin-token"],
      { cwd, fetchImpl, print: () => {} },
    );

    expect(code).toBe(0);
    expect(calls[0]!.url).toBe("http://api.test/functions/echo/disable");
    expect(calls[0]!.init.method).toBe("POST");
  });

  it("surfaces a 409 as a non-zero error", async () => {
    const cwd = await project();
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse(409, {
        error: "no_previous_version",
        details: "echo has no earlier activation to roll back to",
      }),
    );
    const errors: string[] = [];

    const code = await main(
      ["functions", "rollback", "echo", "--url", "http://api.test", "--token", "admin-token"],
      { cwd, fetchImpl, print: () => {}, printError: (line) => errors.push(line) },
    );

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("no_previous_version");
  });

  it("surfaces a 404 as a non-zero error", async () => {
    const cwd = await project();
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse(404, { error: "not_found", details: "echo has no active version" }),
    );
    const errors: string[] = [];

    const code = await main(
      ["functions", "disable", "echo", "--url", "http://api.test", "--token", "admin-token"],
      { cwd, fetchImpl, print: () => {}, printError: (line) => errors.push(line) },
    );

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("not_found");
  });

  it("fails locally without an admin token and sends no request", async () => {
    const cwd = await project();
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(200, {}));
    const errors: string[] = [];

    const code = await main(["functions", "disable", "echo", "--url", "http://api.test"], {
      cwd,
      fetchImpl,
      print: () => {},
      printError: (line) => errors.push(line),
    });

    expect(code).toBe(1);
    expect(calls).toHaveLength(0);
    expect(errors.join("\n")).toMatch(/admin token/);
  });

  it("generates the contract map without the network", async () => {
    const cwd = await project();
    await mkdir(join(cwd, "functions"), { recursive: true });
    await writeFile(
      join(cwd, "functions", "echo.ts"),
      "export const echo = defineFunction({}, () => 1);",
      "utf8",
    );

    const code = await main(["functions", "types"], { cwd, print: () => {} });
    const written = await readFile(join(cwd, "src/ebb-functions.generated.ts"), "utf8");

    expect(code).toBe(0);
    expect(written).toContain('import type { echo } from "../functions/echo";');
    expect(written).toContain('echo: functionContract<typeof echo>("echo"),');
  });

  it("deploys with --force even when the version is unchanged", async () => {
    const cwd = await project();
    await mkdir(join(cwd, "functions"), { recursive: true });
    await writeFile(
      join(cwd, "functions", "echo.ts"),
      `import { defineFunction } from "@ebbjs/server";\nexport const echo = defineFunction({}, () => 1);`,
      "utf8",
    );
    const version = "2026-10-23T12:00:00.000Z";
    const hash = deploymentHashFor(
      (await prepareDeployment(join(cwd, "functions", "echo.ts"), { version })).envelope,
    );

    const { fetchImpl, calls } = recordingFetch((call) => {
      if (call.url.endsWith("/versions") && call.init.method === "GET") {
        return jsonResponse(200, {
          versions: [
            {
              version,
              status: "active",
              createdAt: 1,
              activatedAt: 1,
              pinned: false,
              createdBy: null,
              deploymentHash: hash,
            },
          ],
        });
      }
      if (call.url.endsWith("/versions")) {
        return jsonResponse(201, {
          ok: true,
          name: "echo",
          version,
          status: "retired",
          pinned: false,
        });
      }
      return jsonResponse(200, { ok: true, name: "echo", version, status: "active" });
    });

    const code = await main(
      ["deploy", "--force", "--url", "http://api.test", "--token", "admin-token"],
      { cwd, fetchImpl, print: () => {} },
    );

    expect(code).toBe(0);
    const uploads = calls.filter(
      (call) => call.url.endsWith("/versions") && call.init.method === "POST",
    );
    expect(uploads).toHaveLength(1);
    expect(calls.some((call) => call.url.endsWith("/activate"))).toBe(true);
  });

  it("rejects an unknown deploy flag", async () => {
    const cwd = await project();
    const errors: string[] = [];

    const code = await main(["deploy", "--nope"], {
      cwd,
      print: () => {},
      printError: (line) => errors.push(line),
    });

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("unknown option");
  });

  it("exits non-zero for an unknown command", async () => {
    const cwd = await project();
    const errors: string[] = [];

    const code = await main(["nope"], {
      cwd,
      print: () => {},
      printError: (line) => errors.push(line),
    });

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("unknown command");
  });

  it("prints usage for --help", async () => {
    const lines: string[] = [];

    const code = await main(["--help"], { print: (line) => lines.push(line) });

    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("Usage: ebb <command>");
  });
});
