import { Value } from "@sinclair/typebox/value";
import type { TSchema } from "@sinclair/typebox/type";
import { describe, expect, it } from "vitest";

import {
  defineEntity,
  defineRelationship,
  defineSchema,
  derivedBodyIds,
  e,
  EntityRegistry,
  generatedDocEntityName,
  groupSystemEntity,
} from "../index";

const buildSchema = () => {
  const project = defineEntity("project", { name: e.string() });
  const issue = defineEntity("issue", {
    title: e.string(),
    body: e.collaborativeText(),
    project: e.string().nullable(),
  });
  const belongsTo = defineRelationship({ source: issue, target: project, as: "project" });
  return {
    schema: defineSchema({
      entities: { project, issue },
      relationships: { belongsTo },
      version: 1,
    }),
    issue,
  };
};

describe("@ebbjs/schema", () => {
  it("registers entities, relationships, and expanded derived documents", () => {
    const { schema } = buildSchema();

    expect(schema._registry.entityNames()).toContain("issue");
    expect(schema._registry.getRelationship("issue", "project")?.target.name).toBe("project");
    expect(schema._registry.get(generatedDocEntityName("issue", "body"))).toBeDefined();
  });

  it("derives one document and relationship id for a body", () => {
    const { schema } = buildSchema();
    const facts = {
      registry: schema._registry,
      entityName: "issue",
      parentId: "e_parent",
      field: "body",
    };

    const first = derivedBodyIds(facts);
    const second = derivedBodyIds(facts);

    expect(first).toEqual(second);
    expect(first.documentType).toBe(generatedDocEntityName("issue", "body"));
    expect(first.documentId).toContain("e_parent");
    expect(first.relationshipId).toContain("e_parent");
  });

  it("validates a payload against an entity's wire shape", () => {
    const registry = new EntityRegistry();
    registry.register(defineEntity("issue", { title: e.string() }));
    const issue = registry.get("issue");

    expect(issue).toBeDefined();
    expect(registry.entityNames()).toEqual(["issue"]);
  });
});

describe("group system entity app scope (#732)", () => {
  it("declares apps as a map field", () => {
    expect(groupSystemEntity.fields.apps).toEqual({ type: "lww" });
    expect(groupSystemEntity.shape.properties).toHaveProperty("apps");
  });

  it("models apps as an optional string-keyed map of booleans", () => {
    const properties = groupSystemEntity.shape.properties as Record<string, TSchema>;
    const apps = properties.apps as TSchema;

    expect(Value.Check(apps, { notes: true, issues: false })).toBe(true);
    expect(Value.Check(apps, { notes: "yes" })).toBe(false);
  });
});
