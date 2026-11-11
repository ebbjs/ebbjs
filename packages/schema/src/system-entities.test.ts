/**
 * System entity shapes — the rows the SDK writes itself, validated by
 * `Value.Check` exactly as an app entity is.
 */

import { Value } from "@sinclair/typebox/value";
import type { TSchema } from "@sinclair/typebox/type";
import { describe, expect, it } from "vitest";

import { groupSystemEntity } from "./index";

describe("group system entity app scope (#732)", () => {
  it("models apps as a string-keyed map of booleans", () => {
    const properties = groupSystemEntity.shape.properties as Record<string, TSchema>;
    const apps = properties.apps as TSchema;

    expect(Value.Check(apps, { notes: true, issues: false })).toBe(true);
    expect(Value.Check(apps, { notes: "yes" })).toBe(false);
  });
});
