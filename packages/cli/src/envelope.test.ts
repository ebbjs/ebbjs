import { describe, expect, it } from "vitest";

import {
  buildEnvelope,
  codeFilename,
  digestFor,
  envelopeFilename,
  isValidFunctionName,
  validateEnvelope,
} from "./envelope.ts";

describe("the function name grammar", () => {
  it("accepts a JavaScript identifier of at most 64 characters", () => {
    for (const name of ["a", "A1_b2", "_internal", "proofreadDocument", "a".repeat(64)]) {
      expect(isValidFunctionName(name)).toBe(true);
    }
  });

  it("refuses dashes, leading digits, reserved names, and overlong names", () => {
    for (const name of ["", "1abc", "with-dash", "default", "a".repeat(65), ".", "a.b"]) {
      expect(isValidFunctionName(name)).toBe(false);
    }
  });
});

describe("buildEnvelope", () => {
  it("defaults runtime, contract, access, and limits", () => {
    const envelope = buildEnvelope({ name: "echo", version: "1.0.0", code: "code" });

    expect(envelope).toEqual({
      name: "echo",
      version: "1.0.0",
      digest: digestFor("code"),
      runtime: "bun",
      contract: 1,
      access: "granted",
      timeoutMs: 30_000,
      memoryBytes: 268_435_456,
      entry: "echo",
    });
    expect(validateEnvelope(envelope)).toEqual([]);
  });

  it("omits absent optional schemas and keeps present ones", () => {
    const envelope = buildEnvelope({
      name: "echo",
      version: "1.0.0",
      code: "code",
      paramsSchema: { type: "object" },
      outputSchema: null,
    });

    expect(envelope.paramsSchema).toEqual({ type: "object" });
    expect(envelope).not.toHaveProperty("outputSchema");
  });

  it("names files by name and version", () => {
    expect(codeFilename("echo", "1.0.0")).toBe("echo@1.0.0.js");
    expect(envelopeFilename("echo", "1.0.0")).toBe("echo@1.0.0.envelope.json");
  });
});
