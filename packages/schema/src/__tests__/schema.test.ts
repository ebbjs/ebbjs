import { Value } from "@sinclair/typebox/value";
import type { TSchema } from "@sinclair/typebox/type";
import { describe, expect, it } from "vitest";

import {
  defineEntity,
  defineRelationship,
  defineSchema,
  e,
  EntityKeyMismatchError,
  EntityRegistry,
  groupSystemEntity,
  TextCellSchema,
} from "../index";

const SYSTEM_ENTITY_NAMES = ["entityGroup", "group", "groupMember", "relationship"];

const buildSchema = () => {
  const project = defineEntity("project", { name: e.string() });
  const textDocument = defineEntity(
    "text_document",
    { content: e.map(TextCellSchema), version: e.number() },
    { materialization: "on-demand" },
  );
  const issue = defineEntity("issue", {
    title: e.string(),
    project: e.string().default(""),
  });
  const belongsTo = defineRelationship({ source: issue, target: project, as: "project" });
  const body = defineRelationship({
    source: issue,
    target: textDocument,
    as: "body",
    sourceCardinality: "one",
  });
  return {
    schema: defineSchema({
      entities: { project, issue, text_document: textDocument },
      relationships: { belongsTo, body },
      version: 1,
    }),
    issue,
  };
};

describe("@ebbjs/schema", () => {
  it("registers the entities and relationships the schema declares", () => {
    const { schema } = buildSchema();

    expect(schema._registry.entityNames()).toContain("issue");
    expect(schema._registry.getRelationship("issue", "project")?.target.name).toBe("project");
    expect(schema._registry.getRelationship("issue", "body")?.target.name).toBe("text_document");
  });

  it("produces exactly the entities and relationships it was given", () => {
    const { schema } = buildSchema();

    expect(Object.keys(schema.entities).sort()).toEqual(["issue", "project", "text_document"]);
    expect(Object.keys(schema.relationships ?? {}).sort()).toEqual(["belongsTo", "body"]);
    expect(schema._registry.entityNames().sort()).toEqual(
      [...SYSTEM_ENTITY_NAMES, "issue", "project", "text_document"].sort(),
    );
  });

  it("rejects an entity map key that differs from the definition's name", () => {
    const issue = defineEntity("issue", { title: e.string() });

    expect(() => defineSchema({ entities: { task: issue }, version: 1 })).toThrow(
      EntityKeyMismatchError,
    );
    expect(() => defineSchema({ entities: { task: issue }, version: 1 })).toThrow(
      /does not match the definition's name "issue"/,
    );
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
    expect(groupSystemEntity.fields.apps).toEqual({ type: "lww", map: true });
    expect(groupSystemEntity.shape.properties).toHaveProperty("apps");
  });

  it("models apps as an optional string-keyed map of booleans", () => {
    const properties = groupSystemEntity.shape.properties as Record<string, TSchema>;
    const apps = properties.apps as TSchema;

    expect(Value.Check(apps, { notes: true, issues: false })).toBe(true);
    expect(Value.Check(apps, { notes: "yes" })).toBe(false);
  });
});
