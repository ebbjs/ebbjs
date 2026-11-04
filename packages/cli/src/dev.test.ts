import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { watchFunctions } from "./commands.ts";
import { removeProject, tempProject, waitFor } from "./test-utils.ts";

const emptyResult = { functions: [], drift: null, typesOut: "" };

describe("watchFunctions", () => {
  const projects: string[] = [];

  afterEach(async () => {
    await Promise.all(projects.splice(0).map(removeProject));
  });

  it("deploys everything once, then only the changed entry after the debounce", async () => {
    const cwd = await tempProject("dev-");
    projects.push(cwd);
    await mkdir(join(cwd, "functions"), { recursive: true });
    const entry = join(cwd, "functions", "echo.ts");
    await writeFile(entry, "export const echo = 1;", "utf8");

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

      await writeFile(entry, "export const echo = 2;", "utf8");
      await waitFor(() => changedCalls.length === 1);

      expect(changedCalls[0]).toEqual([entry]);
      expect(errors).toEqual([]);
    } finally {
      close();
    }
  });
});
