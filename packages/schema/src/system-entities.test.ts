/**
 * Platform component shapes — the rows the SDK writes itself, validated by
 * `Value.Check` exactly as an app entity is.
 */

import { Value } from "@sinclair/typebox/value";
import type { TSchema } from "@sinclair/typebox/type";
import { describe, expect, it } from "vitest";

import { EBB_COMPONENTS, EBB_COMPONENT_KINDS, EBB_MODEL_NAME, ebbSystemEntity } from "./index";

const componentShape = (kind: (typeof EBB_COMPONENT_KINDS)[number]): TSchema =>
  ebbSystemEntity.components[kind].shape;

describe("the platform model", () => {
  it("is one model named ebb carrying the four components", () => {
    expect(EBB_MODEL_NAME).toBe("ebb");
    expect(ebbSystemEntity.name).toBe("ebb");
    expect(Object.keys(ebbSystemEntity.components).sort()).toEqual([
      "grant",
      "group",
      "link",
      "membership",
    ]);
  });

  it("names each component `<model>/<kind>` and attaches it under its kind", () => {
    for (const kind of EBB_COMPONENT_KINDS) {
      expect(EBB_COMPONENTS[kind]).toBe(`ebb/${kind}`);
      expect(ebbSystemEntity.components[kind].name).toBe(EBB_COMPONENTS[kind]);
    }
  });

  it("declares every component optional — a row carries one, not all four", () => {
    for (const kind of EBB_COMPONENT_KINDS) {
      expect(ebbSystemEntity.components[kind].optional).toBe(true);
    }
  });
});

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
  it("opts grant, membership, and link into `ebb/<kind>.<verb>`", () => {
    for (const kind of ["grant", "membership", "link"] as const) {
      expect(ebbSystemEntity.components[kind].permission).toBe("own");
    }
  });

  it("leaves a group row on the model's permission subject", () => {
    expect(ebbSystemEntity.components.group.permission).toBeUndefined();
  });
});

describe("platform components declare structural conflict scope", () => {
  it("never surfaces a concurrent edge, membership, or grant write", () => {
    for (const kind of ["grant", "membership", "link"] as const) {
      expect(ebbSystemEntity.components[kind].structural).toBe(true);
    }
  });

  it("leaves a group row on the ordinary default", () => {
    expect(ebbSystemEntity.components.group.structural).toBe(false);
    expect(ebbSystemEntity.components.group.conflictScope).toBeUndefined();
    expect(ebbSystemEntity.conflictScope).toBe("field");
  });
});
