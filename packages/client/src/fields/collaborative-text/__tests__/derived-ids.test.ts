/**
 * The identity contract for derived rows (#695).
 *
 * These are the properties the backfill (#696) leans on: two clients that
 * agree on the facts address the same row, distinct facts never share a
 * row, and no derived id can be reached by minting one.
 */

import { describe, expect, it } from "vitest";
import { generateId } from "@ebbjs/core";

import { e, defineEntity } from "@ebbjs/schema";
import { defineSchema } from "@ebbjs/schema";
import { derivedBodyIds, derivedDocumentId, derivedRelationshipId } from "@ebbjs/schema";

const DOC_TYPE = "text_document__blog_post__body";
const RELATIONSHIP_NAMESPACE = "rel_derived_";
const DOCUMENT_NAMESPACE = "e_derived_";

/**
 * The inverse the encoding must admit: read a decimal length up to the
 * first `_`, then take exactly that many characters, twice. Spelled out
 * here so the injectivity tests assert a property of the format rather
 * than mirror the implementation's own arithmetic.
 */
const decode = (id: string, namespace: string) => {
  const segment = (rest: string): { value: string; rest: string } => {
    const cut = rest.indexOf("_");
    const length = Number(rest.slice(0, cut));
    return { value: rest.slice(cut + 1, cut + 1 + length), rest: rest.slice(cut + 1 + length) };
  };
  const parent = segment(id.slice(namespace.length));
  const field = segment(parent.rest);
  return { parentId: parent.value, field: field.value, tail: field.rest };
};

describe("derivedRelationshipId", () => {
  it("pins a golden vector so a refactor cannot re-identify live rows", () => {
    expect(derivedRelationshipId("e_abc", "body")).toBe("rel_derived_5_e_abc4_body");
  });

  it("decodes back to its inputs with no document type attached", () => {
    const id = derivedRelationshipId("e_abc", "body");
    expect(decode(id, RELATIONSHIP_NAMESPACE)).toEqual({
      parentId: "e_abc",
      field: "body",
      tail: "",
    });
  });

  it("round-trips adversarial parent ids and field names", () => {
    const cases: readonly (readonly [string, string])[] = [
      ["", ""],
      ["e_1", "2"],
      ["e_a1", "9_b"],
      ["e_ab", "c_d"],
      ["e_ab_c", "d"],
      ["e", "_"],
      ["e_" + "a".repeat(40), "_".repeat(40)],
      ["e_abc", "näme"],
      ["4_a", "5_b"],
    ];
    for (const [parentId, field] of cases) {
      expect(decode(derivedRelationshipId(parentId, field), RELATIONSHIP_NAMESPACE)).toEqual({
        parentId,
        field,
        tail: "",
      });
    }
  });

  it("keeps the pair the readable `parent_field` form would collapse apart", () => {
    expect(derivedRelationshipId("e_ab", "c_d")).not.toBe(derivedRelationshipId("e_ab_c", "d"));
    expect(derivedRelationshipId("e_ab", "body")).not.toBe(derivedRelationshipId("e_abb", "ody"));
  });

  it("is injective across a grid of adversarial field names and parent ids", () => {
    const fields = ["", "_", "0", "a", "a_", "_a", "body", "4_a", "b", "9_b", "e_ab_c"];
    const ids = fields.map((field) => derivedRelationshipId("e_ab", field));
    expect(new Set(ids).size).toBe(fields.length);

    const parents = ["e_a1", "e_a", "e_", "e", ""];
    const parentIds = parents.map((parent) => derivedRelationshipId(parent, "body"));
    expect(new Set(parentIds).size).toBe(parents.length);
  });
});

describe("derivedDocumentId", () => {
  it("pins a golden vector", () => {
    expect(derivedDocumentId("e_abc", "body", DOC_TYPE)).toBe(
      "e_derived_5_e_abc4_bodytext_document__blog_post__body",
    );
  });

  it("decodes back to its inputs, with the document type as the whole tail", () => {
    expect(decode(derivedDocumentId("e_abc", "body", DOC_TYPE), DOCUMENT_NAMESPACE)).toEqual({
      parentId: "e_abc",
      field: "body",
      tail: DOC_TYPE,
    });
  });

  it("round-trips a document type that looks like the encoded key", () => {
    const cases: readonly (readonly [string, string, string])[] = [
      ["e_ab", "body", "5_x"],
      ["e_a", "b", "body5_x"],
      ["", "", ""],
      ["e_ab", "", "text_document__a__b"],
      ["e_1", "2", "_"],
    ];
    for (const [parentId, field, documentType] of cases) {
      expect(decode(derivedDocumentId(parentId, field, documentType), DOCUMENT_NAMESPACE)).toEqual({
        parentId,
        field,
        tail: documentType,
      });
    }
  });

  it("gives one field two document types two documents", () => {
    expect(derivedDocumentId("e_abc", "body", "text_document__blog_post__body")).not.toBe(
      derivedDocumentId("e_abc", "body", "text_document__article__body"),
    );
  });
});

describe("derivedBodyIds", () => {
  const bodyPost = defineEntity("blog_post", { body: e.collaborativeText() });
  const generatedDocSchema = defineSchema({ entities: { bodyPost }, version: 1 });

  const overriddenPost = defineEntity("blog_post", {
    body: e.collaborativeText({ entity: "article_body" }),
  });
  const overrideDocSchema = defineSchema({ entities: { overriddenPost }, version: 1 });

  it("resolves the generated document entity name", () => {
    expect(
      derivedBodyIds({
        registry: generatedDocSchema._registry,
        entityName: "blog_post",
        parentId: "e_abc",
        field: "body",
      }),
    ).toEqual({
      documentType: DOC_TYPE,
      documentId: derivedDocumentId("e_abc", "body", DOC_TYPE),
      relationshipId: derivedRelationshipId("e_abc", "body"),
    });
  });

  it("honours a document entity the field names explicitly", () => {
    expect(
      derivedBodyIds({
        registry: overrideDocSchema._registry,
        entityName: "blog_post",
        parentId: "e_abc",
        field: "body",
      }),
    ).toEqual({
      documentType: "article_body",
      documentId: derivedDocumentId("e_abc", "body", "article_body"),
      relationshipId: derivedRelationshipId("e_abc", "body"),
    });
  });

  it("gives one field two document types two documents and one relationship id", () => {
    const facts = { entityName: "blog_post", parentId: "e_abc", field: "body" } as const;
    const generated = derivedBodyIds({ ...facts, registry: generatedDocSchema._registry });
    const overridden = derivedBodyIds({ ...facts, registry: overrideDocSchema._registry });

    expect(generated.documentId).not.toBe(overridden.documentId);
    expect(generated.relationshipId).toBe(overridden.relationshipId);
  });
});

describe("derived ids vs minted ids", () => {
  it("stays in a namespace minting cannot reach", () => {
    const minted = Array.from({ length: 500 }, (_, i) => generateId(i % 2 === 0 ? "e" : "rel"));
    // A minted payload is 16 chars of `[a-z0-9]`, so a minted id splits on
    // `_` exactly once. A second `_` is what makes these namespaces
    // unreachable rather than merely improbable.
    expect(minted.every((id) => id.split("_").length === 2)).toBe(true);
    for (const id of [
      derivedRelationshipId("e_abc", "body"),
      derivedDocumentId("e_abc", "body", DOC_TYPE),
    ]) {
      expect(id.split("_").length).toBeGreaterThan(2);
    }
  });
});
