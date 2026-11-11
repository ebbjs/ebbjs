import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { type App } from "./api.ts";
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

  it("surfaces a server refusal as a non-zero exit with the server's code", async () => {
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
    expect(errors.join("\n")).toContain("HTTP 409 no_previous_version");
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
    expect(lines.join("\n")).toContain("ebb apps list");
    expect(lines.join("\n")).toContain("browser origins");
    expect(lines.join("\n")).toContain("authorization, and non-browser clients");
    expect(lines.join("\n")).toContain("EBB_CORS_ALLOW_ANY");
  });
});

describe("apps commands", () => {
  const projects: string[] = [];

  const project = async (): Promise<string> => {
    const dir = await tempProject("apps-commands-");
    projects.push(dir);
    return dir;
  };

  afterEach(async () => {
    await Promise.all(projects.splice(0).map(removeProject));
  });

  const registered = (overrides: Partial<App> = {}): App => ({
    id: "app_1",
    name: "issue-tracker",
    origins: ["https://issues.example.com"],
    created_at: "2026-11-01T12:00:00Z",
    ...overrides,
  });

  it("registers a new app with normalized origins and the admin token", async () => {
    const cwd = await project();
    const origins = ["https://issues.example.com", "http://localhost:5173"];
    const { fetchImpl, calls } = recordingFetch((call) =>
      call.init.method === "GET"
        ? jsonResponse(200, { apps: [] })
        : jsonResponse(201, { app: registered({ origins }) }),
    );
    const lines: string[] = [];

    const code = await main(
      [
        "apps",
        "add",
        "issue-tracker",
        "--origin",
        "HTTPS://Issues.Example.com:443",
        "--origin",
        "http://localhost:5173/",
        "--url",
        "http://api.test",
        "--token",
        "admin-token",
      ],
      { cwd, fetchImpl, print: (line) => lines.push(line) },
    );

    expect(code).toBe(0);
    expect(calls.map((call) => [call.url, call.init.method])).toEqual([
      ["http://api.test/admin/apps", "GET"],
      ["http://api.test/admin/apps", "POST"],
    ]);
    expect(requestHeaders(calls[1]!).get("authorization")).toBe("Bearer admin-token");
    expect(jsonBody(calls[1]!)).toEqual({ name: "issue-tracker", origins });
    expect(lines.join("\n")).toContain("added issue-tracker (app_1)");
  });

  it("re-running the same add is a no-op", async () => {
    const cwd = await project();
    const origins = ["https://issues.example.com", "http://localhost:5173"];
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse(200, { apps: [registered({ origins })] }),
    );
    const lines: string[] = [];

    const code = await main(
      [
        "apps",
        "add",
        "issue-tracker",
        "--origin",
        "https://issues.example.com",
        "--origin",
        "http://localhost:5173",
        "--url",
        "http://api.test",
        "--token",
        "admin-token",
      ],
      { cwd, fetchImpl, print: (line) => lines.push(line) },
    );

    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.method).toBe("GET");
    expect(lines.join("\n")).toContain("unchanged issue-tracker (app_1)");
  });

  it("adds only the origins an existing app is missing", async () => {
    const cwd = await project();
    const { fetchImpl, calls } = recordingFetch((call) => {
      if (call.init.method === "GET") return jsonResponse(200, { apps: [registered()] });
      return jsonResponse(200, {
        app: registered({ origins: ["https://issues.example.com", "http://localhost:5173"] }),
      });
    });
    const lines: string[] = [];

    const code = await main(
      [
        "apps",
        "add",
        "issue-tracker",
        "--origin",
        "https://issues.example.com",
        "--origin",
        "http://localhost:5173",
        "--url",
        "http://api.test",
        "--token",
        "admin-token",
      ],
      { cwd, fetchImpl, print: (line) => lines.push(line) },
    );

    expect(code).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toBe("http://api.test/admin/apps/app_1/origins");
    expect(jsonBody(calls[1]!)).toEqual({ origin: "http://localhost:5173" });
    expect(lines.join("\n")).toContain("added http://localhost:5173 to issue-tracker (app_1)");
  });

  it("reports the server's duplicate name when the case differs", async () => {
    const cwd = await project();
    const { fetchImpl, calls } = recordingFetch((call) =>
      call.init.method === "GET"
        ? jsonResponse(200, { apps: [registered({ name: "Issue-Tracker" })] })
        : jsonResponse(409, {
            error: "duplicate_name",
            details: "An app with that name exists.",
          }),
    );
    const errors: string[] = [];

    const code = await main(
      [
        "apps",
        "add",
        "issue-tracker",
        "--origin",
        "https://issues.example.com",
        "--url",
        "http://api.test",
        "--token",
        "admin-token",
      ],
      { cwd, fetchImpl, print: () => {}, printError: (line) => errors.push(line) },
    );

    expect(code).toBe(1);
    expect(calls[1]!.init.method).toBe("POST");
    expect(errors.join("\n")).toContain("duplicate_name");
  });

  it("reports a conflicting origin as the server's error", async () => {
    const cwd = await project();
    const { fetchImpl } = recordingFetch((call) =>
      call.init.method === "GET"
        ? jsonResponse(200, { apps: [] })
        : jsonResponse(409, {
            error: "duplicate_origin",
            details: "That origin is already registered.",
          }),
    );
    const errors: string[] = [];

    const code = await main(
      [
        "apps",
        "add",
        "previews",
        "--origin",
        "https://issues.example.com",
        "--url",
        "http://api.test",
        "--token",
        "admin-token",
      ],
      { cwd, fetchImpl, print: () => {}, printError: (line) => errors.push(line) },
    );

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("duplicate_origin");
  });

  it("warns about a wildcard origin and still registers it", async () => {
    const cwd = await project();
    const { fetchImpl, calls } = recordingFetch((call) =>
      call.init.method === "GET"
        ? jsonResponse(200, { apps: [] })
        : jsonResponse(201, {
            app: registered({ name: "previews", origins: ["https://*.example.com"] }),
          }),
    );
    const warnings: string[] = [];

    const code = await main(
      [
        "apps",
        "add",
        "previews",
        "--origin",
        "https://*.example.com",
        "--url",
        "http://api.test",
        "--token",
        "admin-token",
      ],
      { cwd, fetchImpl, print: () => {}, printError: (line) => warnings.push(line) },
    );

    expect(code).toBe(0);
    expect(jsonBody(calls[1]!)).toEqual({
      name: "previews",
      origins: ["https://*.example.com"],
    });
    expect(warnings.join("\n")).toContain("wildcard origin");
  });

  it("rejects an add without any --origin", async () => {
    const cwd = await project();
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(200, { apps: [] }));
    const errors: string[] = [];

    const code = await main(
      ["apps", "add", "issue-tracker", "--url", "http://api.test", "--token", "admin-token"],
      { cwd, fetchImpl, print: () => {}, printError: (line) => errors.push(line) },
    );

    expect(code).toBe(1);
    expect(calls).toHaveLength(0);
    expect(errors.join("\n")).toContain("at least one --origin");
  });

  it("deduplicates repeated --origin values before creating an app", async () => {
    const cwd = await project();
    const { fetchImpl, calls } = recordingFetch((call) =>
      call.init.method === "GET"
        ? jsonResponse(200, { apps: [] })
        : jsonResponse(201, { app: registered() }),
    );

    const code = await main(
      [
        "apps",
        "add",
        "issue-tracker",
        "--origin",
        "https://issues.example.com",
        "--origin",
        "HTTPS://Issues.Example.com:443/",
        "--url",
        "http://api.test",
        "--token",
        "admin-token",
      ],
      { cwd, fetchImpl, print: () => {} },
    );

    expect(code).toBe(0);
    expect(jsonBody(calls[1]!)).toEqual({
      name: "issue-tracker",
      origins: ["https://issues.example.com"],
    });
  });

  it("exits non-zero for an unknown apps command", async () => {
    const cwd = await project();
    const errors: string[] = [];

    const code = await main(["apps", "nope"], {
      cwd,
      print: () => {},
      printError: (line) => errors.push(line),
    });

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("unknown apps command");
  });

  it("rejects an invalid origin before loading config or sending a request", async () => {
    const cwd = await project();
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(200, { apps: [] }));
    const errors: string[] = [];

    const code = await main(
      [
        "apps",
        "add",
        "issue-tracker",
        "--origin",
        "https://issues.example.com/path",
        "--url",
        "http://api.test",
        "--token",
        "admin-token",
      ],
      { cwd, fetchImpl, print: () => {}, printError: (line) => errors.push(line) },
    );

    expect(code).toBe(1);
    expect(calls).toHaveLength(0);
    expect(errors.join("\n")).toContain("invalid origin");
  });

  it("lists apps as tab-separated name, id, origins, and created date", async () => {
    const cwd = await project();
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse(200, {
        apps: [
          registered({
            origins: ["https://issues.example.com", "http://localhost:5173"],
          }),
        ],
      }),
    );
    const lines: string[] = [];

    const code = await main(
      ["apps", "list", "--url", "http://api.test", "--token", "admin-token"],
      { cwd, fetchImpl, print: (line) => lines.push(line) },
    );

    expect(code).toBe(0);
    expect(lines).toEqual([
      "issue-tracker\tapp_1\thttps://issues.example.com,http://localhost:5173\t2026-11-01T12:00:00Z",
    ]);
  });

  it("prints a stable JSON list for CI", async () => {
    const cwd = await project();
    const zeta = registered({ id: "app_2", name: "zeta", origins: ["https://zeta.example.com"] });
    const alpha = registered({
      id: "app_1",
      name: "alpha",
      origins: ["https://alpha.example.com"],
    });
    const { fetchImpl } = recordingFetch(() => jsonResponse(200, { apps: [zeta, alpha] }));
    const lines: string[] = [];

    const code = await main(
      ["apps", "list", "--json", "--url", "http://api.test", "--token", "admin-token"],
      { cwd, fetchImpl, print: (line) => lines.push(line) },
    );

    expect(code).toBe(0);
    expect(lines.join("\n")).toBe(
      JSON.stringify(
        {
          apps: [
            {
              id: "app_1",
              name: "alpha",
              origins: ["https://alpha.example.com"],
              created_at: "2026-11-01T12:00:00Z",
            },
            {
              id: "app_2",
              name: "zeta",
              origins: ["https://zeta.example.com"],
              created_at: "2026-11-01T12:00:00Z",
            },
          ],
        },
        null,
        2,
      ),
    );
  });

  it("removes an app by name and prints the preflight revocation note", async () => {
    const cwd = await project();
    const { fetchImpl, calls } = recordingFetch((call) =>
      call.init.method === "GET"
        ? jsonResponse(200, { apps: [registered()] })
        : new Response(null, { status: 204 }),
    );
    const lines: string[] = [];

    const code = await main(
      ["apps", "remove", "issue-tracker", "--url", "http://api.test", "--token", "admin-token"],
      { cwd, fetchImpl, print: (line) => lines.push(line) },
    );

    expect(code).toBe(0);
    expect(calls[1]!.url).toBe("http://api.test/admin/apps/app_1");
    expect(calls[1]!.init.method).toBe("DELETE");
    expect(lines.join("\n")).toContain("removed issue-tracker (app_1)");
    expect(lines.join("\n")).toContain("300s");
  });

  it("adds one origin to an app by name", async () => {
    const cwd = await project();
    const { fetchImpl, calls } = recordingFetch((call) =>
      call.init.method === "GET"
        ? jsonResponse(200, { apps: [registered()] })
        : jsonResponse(200, {
            app: registered({
              origins: ["https://issues.example.com", "http://localhost:5173"],
            }),
          }),
    );
    const lines: string[] = [];

    const code = await main(
      [
        "apps",
        "origin",
        "add",
        "issue-tracker",
        "HTTP://Localhost:5173/",
        "--url",
        "http://api.test",
        "--token",
        "admin-token",
      ],
      { cwd, fetchImpl, print: (line) => lines.push(line) },
    );

    expect(code).toBe(0);
    expect(calls[1]!.url).toBe("http://api.test/admin/apps/app_1/origins");
    expect(jsonBody(calls[1]!)).toEqual({ origin: "http://localhost:5173" });
    expect(lines.join("\n")).toContain("added http://localhost:5173 to issue-tracker (app_1)");
  });

  it("removes one origin with the canonical origin URL-encoded in the path", async () => {
    const cwd = await project();
    const { fetchImpl, calls } = recordingFetch((call) =>
      call.init.method === "GET"
        ? jsonResponse(200, { apps: [registered()] })
        : jsonResponse(200, { app: registered({ origins: [] }) }),
    );
    const lines: string[] = [];

    const code = await main(
      [
        "apps",
        "origin",
        "remove",
        "issue-tracker",
        "HTTPS://Issues.Example.com:443/",
        "--url",
        "http://api.test",
        "--token",
        "admin-token",
      ],
      { cwd, fetchImpl, print: (line) => lines.push(line) },
    );

    expect(code).toBe(0);
    expect(calls[1]!.url).toBe(
      "http://api.test/admin/apps/app_1/origins/https%3A%2F%2Fissues.example.com",
    );
    expect(calls[1]!.init.method).toBe("DELETE");
    expect(lines.join("\n")).toContain("removed https://issues.example.com from issue-tracker");
    expect(lines.join("\n")).toContain("300s");
  });

  it("fails when an app name cannot be resolved", async () => {
    const cwd = await project();
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(200, { apps: [] }));
    const errors: string[] = [];

    const code = await main(
      ["apps", "remove", "missing", "--url", "http://api.test", "--token", "admin-token"],
      { cwd, fetchImpl, print: () => {}, printError: (line) => errors.push(line) },
    );

    expect(code).toBe(1);
    expect(calls).toHaveLength(1);
    expect(errors.join("\n")).toContain('no app named "missing"');
  });
});
