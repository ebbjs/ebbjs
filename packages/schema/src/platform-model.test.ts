/**
 * The shapes of the platform's four components: the three atomic row values,
 * validated by `Value.Check` exactly as an app entity is, and the keyed link
 * component whose nesting is the edge's key.
 */

import { Value } from "@sinclair/typebox/value";
import type { TSchema } from "@sinclair/typebox/type";
import { describe, expect, it } from "vitest";

import { EBB_COMPONENT_KINDS, ebbModel } from "./index";

/** The three kinds that are one atomic value on a row of their own. */
const ROW_KINDS = ["group", "grant", "membership"] as const;

const componentShape = (kind: (typeof EBB_COMPONENT_KINDS)[number]): TSchema =>
  ebbModel.components[kind].shape;

describe("platform component values are atomic", () => {
  it("closes every value's property set", () => {
    for (const kind of ROW_KINDS) {
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
});

describe("ebb/link is keyed on its source", () => {
  it("nests accessor, type, and target id, with presence at the leaf", () => {
    const link = componentShape("link");

    expect(Value.Check(link, { dependsOn: { todo: { todo_2: true } } })).toBe(true);
    // A tombstoned key stays a boolean position; the wire leaf wraps it.
    expect(Value.Check(link, { dependsOn: { todo: { todo_2: null } } })).toBe(false);
    expect(Value.Check(link, { dependsOn: { todo: true } })).toBe(false);
  });

  it("declares no scope owner: it inherits its host row's membership", () => {
    expect(ebbModel.components.link.scope).toBeUndefined();
  });
});

describe("platform components and conflict scope", () => {
  it("leaves a group row detectable, unlike the structural components", () => {
    // `group` is the one platform component a concurrent write should surface;
    // the membership, grant, and link are the three `structural` exemptions.
    expect(ebbModel.components.group.structural).toBe(false);
  });
});

describe("platform components declare their scope owner", () => {
  it("names the entity each atomic write's group set resolves against", () => {
    // A group's scope is itself and a grant's is the group it names, so neither
    // carries a membership row.
    expect(ebbModel.components.group.scope).toBe("self");
    expect(ebbModel.components.grant.scope).toBe("group_id");
    expect(ebbModel.components.membership.scope).toBe("group_id");
  });
});
