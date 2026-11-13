/**
 * The values of the platform's four components, validated by `Value.Check`
 * exactly as an app entity is.
 */

import { Value } from "@sinclair/typebox/value";
import type { TSchema } from "@sinclair/typebox/type";
import { describe, expect, it } from "vitest";

import { EBB_COMPONENT_KINDS, ebbSystemEntity } from "./index";

const componentShape = (kind: (typeof EBB_COMPONENT_KINDS)[number]): TSchema =>
  ebbSystemEntity.components[kind].shape;

describe("platform component values are atomic", () => {
  it("closes every value's property set", () => {
    for (const kind of EBB_COMPONENT_KINDS) {
      const shape = componentShape(kind);
      const properties = (shape as unknown as { properties: Record<string, TSchema> }).properties;
      const sample = Object.fromEntries(
        Object.keys(properties).map((key) => [
          key,
          key === "apps" || key === "permissions" ? [] : "x",
        ]),
      );

      expect(Value.Check(shape, sample)).toBe(true);
      expect(Value.Check(shape, { ...sample, extra: "no" })).toBe(false);
    }
  });

  it("accepts a group's app scope as a list of app ids", () => {
    const group = componentShape("group");

    expect(Value.Check(group, { name: "Team", apps: ["notes", "issues"] })).toBe(true);
    // Absent scope is every app; an empty list is no app, and is not absence.
    expect(Value.Check(group, { name: "Team" })).toBe(true);
    expect(Value.Check(group, { name: "Team", apps: [] })).toBe(true);
    expect(Value.Check(group, { name: "Team", apps: { notes: true } })).toBe(false);
  });

  it("accepts a link's four fields and nothing else", () => {
    const link = componentShape("link");

    expect(
      Value.Check(link, {
        source_id: "todo_1",
        target_id: "todo_2",
        type: "todo",
        field: "dependsOn",
      }),
    ).toBe(true);
  });
});

describe("platform components declare their own permission", () => {
  it("keeps the four grants distinct as `ebb/<kind>.<verb>`", () => {
    for (const kind of EBB_COMPONENT_KINDS) {
      expect(ebbSystemEntity.components[kind].permission).toBe("own");
    }
  });
});

describe("platform components and conflict scope", () => {
  it("leaves a group row detectable, unlike the structural components", () => {
    // `group` is the one platform component a concurrent write should surface;
    // the edge, membership, and grant are the three `structural` exemptions.
    expect(ebbSystemEntity.components.group.structural).toBe(false);
  });
});
