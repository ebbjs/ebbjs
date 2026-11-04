import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { watchFunctions } from "./commands.ts";
import {
  jsonBody,
  jsonResponse,
  recordingFetch,
  removeProject,
  tempProject,
  waitFor,
} from "./test-utils.ts";

const emptyResult = { functions: [], drift: null, typesOut: "" };

const uploads = (calls: readonly { url: string }[]) =>
  calls.filter((call) => call.url.endsWith("/versions"));

describe("watchFunctions", () => {
  const projects: string[] = [];

  afterEach(async () => {
    await Promise.all(projects.splice(0).map(removeProject));
  });

  it("is an idle no-op when the project has no functions directory", async () => {
    const cwd = await tempProject("dev-empty-");
    projects.push(cwd);

    const printed: string[] = [];
    let deployed = false;

    const close = await watchFunctions({
      cwd,
      deployAll: async () => {
        deployed = true;
        return emptyResult;
      },
      print: (line) => printed.push(line),
    });

    expect(deployed).toBe(false);
    expect(printed).toEqual([`no functions directory at ${join(cwd, "functions")}; not watching`]);
    close();
  });

  it("uploads and activates a new version when an entry changes", async () => {
    const cwd = await tempProject("dev-real-");
    projects.push(cwd);
    await mkdir(join(cwd, "functions"), { recursive: true });
    const entry = join(cwd, "functions", "echo.ts");
    const source = (value: number) =>
      `import { defineFunction } from "@ebbjs/server";\n` +
      `export const echo = defineFunction({}, async () => ${value});`;

    await writeFile(entry, source(1), "utf8");

    const { fetchImpl, calls } = recordingFetch((call) => {
      if (call.url.endsWith("/versions")) {
        const body = jsonBody(call);
        return jsonResponse(201, {
          ok: true,
          name: "echo",
          version: (body.envelope as { version: string }).version,
          status: "retired",
          pinned: false,
        });
      }
      if (call.url.endsWith("/activate")) {
        return jsonResponse(200, {
          ok: true,
          name: "echo",
          version: jsonBody(call).version,
          status: "active",
        });
      }
      throw new Error(`unexpected request ${call.url}`);
    });

    const errors: string[] = [];
    const close = await watchFunctions({
      cwd,
      debounceMs: 20,
      fetchImpl,
      config: {
        cwd,
        url: "http://localhost:4001",
        token: "admin-token",
        functions: {
          dir: join(cwd, "functions"),
          typesOut: join(cwd, "src/ebb-functions.generated.ts"),
        },
      },
      print: () => {},
      printError: (line) => errors.push(line),
    });

    try {
      await waitFor(() => uploads(calls).length === 1);

      await writeFile(entry, source(2), "utf8");
      await waitFor(() => uploads(calls).length === 2);

      expect(calls.filter((call) => call.url.endsWith("/activate"))).toHaveLength(2);
      expect(errors).toEqual([]);
    } finally {
      close();
    }
  });

  it("deploys everything once, then only the changed entry after the debounce", async () => {
    const cwd = await tempProject("dev-");
    projects.push(cwd);
    await mkdir(join(cwd, "functions"), { recursive: true });
    const entry = join(cwd, "functions", "echo.ts");
    await writeFile(entry, "export const echo = defineFunction({}, () => 1);", "utf8");

    let allCalls = 0;
    const changedCalls: string[][] = [];
    const errors: string[] = [];

    const close = await watchFunctions({
      cwd,
      debounceMs: 20,
      deployAll: async () => {
        allCalls += 1;
        return emptyResult;
      },
      deployChanged: async (paths) => {
        changedCalls.push([...paths]);
        return emptyResult;
      },
      print: () => {},
      printError: (line) => errors.push(line),
    });

    try {
      expect(allCalls).toBe(1);
      expect(await readFile(join(cwd, "src/ebb-functions.generated.ts"), "utf8")).toContain(
        'import type { echo } from "../functions/echo";',
      );

      await writeFile(entry, "export const echo = defineFunction({}, () => 2);", "utf8");
      await waitFor(() => changedCalls.length === 1);

      expect(changedCalls[0]).toEqual([entry]);
      expect(errors).toEqual([]);
    } finally {
      close();
    }
  });
});
