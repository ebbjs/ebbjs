import { describe, expect, it } from "vitest";
import { e, collaborativeTextFieldMarker } from "./collaborative-text";

describe("e.collaborativeText", () => {
  it("returns the causal-tree type marker", () => {
    expect(e.collaborativeText()).toEqual({ type: "causal-tree" });
    expect(e.collaborativeText()).toBe(collaborativeTextFieldMarker);
  });

  it("has the same identity on repeated calls (constant marker)", () => {
    expect(e.collaborativeText()).toBe(e.collaborativeText());
  });
});

describe("e.lww markers", () => {
  it("e.string returns the lww marker", () => {
    expect(e.string()).toEqual({ type: "lww" });
  });

  it("e.number returns the lww marker", () => {
    expect(e.number()).toEqual({ type: "lww" });
  });

  it("e.boolean returns the lww marker", () => {
    expect(e.boolean()).toEqual({ type: "lww" });
  });
});
