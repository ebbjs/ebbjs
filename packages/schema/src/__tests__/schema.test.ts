import { Value } from "@sinclair/typebox/value";
import type { TSchema } from "@sinclair/typebox/type";
import { describe, expect, it } from "vitest";

import {
  defineModel,
  defineRelationship,
  defineSchema,
  e,
  ModelKeyMismatchError,
  ModelRegistry,
  groupSystemEntity,
  TextCellSchema,
} from "../index";

const SYSTEM_ENTITY_NAMES = ["entityGroup", "group", "groupMember", "relationship"];

const buildSchema = () => {
  const project = defineModel("project", { name: e.string() });
  const textDocument = defineModel(
    "text_document",
    { content: e.map(TextCellSchema), version: e.number() },
    { materialization: "on-demand" },
  );
  const issue = defineModel("issue", {
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
      models: { project, issue, text_document: textDocument },
      relationships: { belongsTo, body },
      version: 1,
    }),
    issue,
  };
};

describe("@ebbjs/schema", () => {
  it("registers the models and relationships the schema declares", () => {
    const { schema } = buildSchema();

    expect(schema._registry.modelNames()).toContain("issue");
    expect(schema._registry.getRelationship("issue", "project")?.target.name).toBe("project");
    expect(schema._registry.getRelationship("issue", "body")?.target.name).toBe("text_document");
  });

  it("produces exactly the models and relationships it was given", () => {
    const { schema } = buildSchema();

    expect(Object.keys(schema.models).sort()).toEqual(["issue", "project", "text_document"]);
    expect(Object.keys(schema.relationships ?? {}).sort()).toEqual(["belongsTo", "body"]);
    expect(schema._registry.modelNames().sort()).toEqual(
      [...SYSTEM_ENTITY_NAMES, "issue", "project", "text_document"].sort(),
    );
  });

  it("rejects an model map key that differs from the definition's name", () => {
    const issue = defineModel("issue", { title: e.string() });

    expect(() => defineSchema({ models: { task: issue }, version: 1 })).toThrow(
      ModelKeyMismatchError,
    );
    expect(() => defineSchema({ models: { task: issue }, version: 1 })).toThrow(
      /does not match the definition's name "issue"/,
    );
  });

  it("validates a payload against an model's wire shape", () => {
    const registry = new ModelRegistry();
    registry.register(defineModel("issue", { title: e.string() }));
    const issue = registry.get("issue");

    expect(issue).toBeDefined();
    expect(registry.modelNames()).toEqual(["issue"]);
  });
});

describe("group system entity app scope (#732)", () => {
  it("declares apps as a map field", () => {
    expect(groupSystemEntity.components.apps.marker).toEqual({ type: "lww", map: true });
    expect(groupSystemEntity.shape.properties).toHaveProperty("apps");
  });

  it("models apps as an optional string-keyed map of booleans", () => {
    const properties = groupSystemEntity.shape.properties as Record<string, TSchema>;
    const apps = properties.apps as TSchema;

    expect(Value.Check(apps, { notes: true, issues: false })).toBe(true);
    expect(Value.Check(apps, { notes: "yes" })).toBe(false);
  });
});
