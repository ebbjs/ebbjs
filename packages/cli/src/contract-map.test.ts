import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { checkDrift, hasDrift, renderContractMap, writeContractMap } from "./contract-map.ts";
import { removeProject, tempProject } from "./test-utils.ts";

describe("renderContractMap", () => {
  it("renders the issue's shape with a type-only import per function", () => {
    const rendered = renderContractMap(
      [{ name: "proofreadDocument", path: "/project/functions/proofreadDocument.ts" }],
      "/project/src/ebb-functions.generated.ts",
      { cwd: "/project", displayPath: "src/ebb-functions.generated.ts" },
    );

    expect(rendered).toBe(
      [
        "// src/ebb-functions.generated.ts — emitted by `ebb deploy` / `ebb functions types`",
        'import { functionContract } from "@ebbjs/client";',
        'import type { proofreadDocument } from "../functions/proofreadDocument";',
        "",
        "export const functions = {",
        '  proofreadDocument: functionContract<typeof proofreadDocument>("proofreadDocument"),',
        "};",
        "",
      ].join("\n"),
    );
  });

  it("uses POSIX relative specifiers and preserves entry order", () => {
    const rendered = renderContractMap(
      [
        { name: "beta", path: "/project/functions/nested/beta.ts" },
        { name: "alpha", path: "/project/functions/alpha.ts" },
      ],
      "/project/src/types/functions.ts",
      { cwd: "/project" },
    );

    expect(rendered).toContain('import type { beta } from "../../functions/nested/beta";');
    expect(rendered).toContain('import type { alpha } from "../../functions/alpha";');
    expect(rendered.indexOf("beta:")).toBeLessThan(rendered.indexOf("alpha:"));
  });

  it("emits an empty map for an empty functions directory", () => {
    const rendered = renderContractMap([], "/project/src/ebb-functions.generated.ts", {
      cwd: "/project",
      displayPath: "src/ebb-functions.generated.ts",
    });

    expect(rendered).toContain("export const functions = {};");
    expect(rendered).not.toContain("import type");
  });
});

describe("writeContractMap", () => {
  const projects: string[] = [];

  afterEach(async () => {
    await Promise.all(projects.splice(0).map(removeProject));
  });

  it("creates the parent directory and writes the generated file", async () => {
    const cwd = await tempProject("map-");
    projects.push(cwd);
    const typesOut = join(cwd, "src/types/functions.ts");

    const path = await writeContractMap(
      [{ name: "echo", path: join(cwd, "functions/echo.ts") }],
      typesOut,
      { cwd, displayPath: "src/types/functions.ts" },
    );

    const written = await readFile(path, "utf8");
    expect(path).toBe(resolve(typesOut));
    expect(written).toContain("// src/types/functions.ts — emitted by");
    expect(written).toContain('import type { echo } from "../../functions/echo";');
  });
});

describe("checkDrift", () => {
  it("reports deployed-only names as missing and generated-only names as extra", () => {
    const drift = checkDrift(
      [
        { name: "shared", path: "/project/functions/shared.ts" },
        { name: "localOnly", path: "/project/functions/localOnly.ts" },
      ],
      ["shared", "deployedOnly"],
    );

    expect(drift).toEqual({
      missing: ["deployedOnly"],
      extra: ["localOnly"],
    });
    expect(hasDrift(drift)).toBe(true);
  });

  it("accepts bare entry paths and reports no drift when the sets match", () => {
    expect(checkDrift(["/project/functions/echo.ts"], ["echo"])).toEqual({
      missing: [],
      extra: [],
    });
    expect(hasDrift(checkDrift(["/project/functions/echo.ts"], ["echo"]))).toBe(false);
  });
});
