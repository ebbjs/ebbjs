import { describe, expect, it } from "vitest";

import { deploymentHashFor } from "./deployment-hash.ts";
import { buildEnvelope, digestFor, type FunctionEnvelope } from "./envelope.ts";

const baseEnvelope = (): FunctionEnvelope =>
  buildEnvelope({
    name: "echo",
    version: "2026-10-23T12:00:00.000Z",
    code: "export const echo = 1;",
    access: "authenticated",
    timeoutMs: 5000,
    memoryBytes: 64 * 1024 * 1024,
    paramsSchema: { type: "object", properties: { id: { type: "string" } } },
    outputSchema: { type: "object", properties: { count: { type: "number" } } },
  });

describe("deploymentHashFor", () => {
  it("does not depend on the source object's key order", () => {
    const envelope = baseEnvelope();
    const reordered = Object.fromEntries(
      Object.entries(envelope).reverse(),
    ) as unknown as FunctionEnvelope;

    expect(deploymentHashFor(reordered)).toBe(deploymentHashFor(envelope));
  });

  it("covers the code digest", () => {
    const envelope = baseEnvelope();
    expect(deploymentHashFor({ ...envelope, digest: digestFor("other code") })).not.toBe(
      deploymentHashFor(envelope),
    );
  });

  it("covers every behaviour-bearing envelope field", () => {
    const envelope = baseEnvelope();
    const changes: FunctionEnvelope[] = [
      // `runtime` has one legal value today; the hash still has to cover it.
      { ...envelope, runtime: "other" as FunctionEnvelope["runtime"] },
      { ...envelope, contract: 2 },
      { ...envelope, access: "granted" },
      { ...envelope, timeoutMs: 6000 },
      { ...envelope, memoryBytes: 128 * 1024 * 1024 },
      { ...envelope, entry: "other" },
      { ...envelope, paramsSchema: { type: "object", properties: {} } },
      { ...envelope, outputSchema: undefined },
    ];

    for (const change of changes) {
      expect(deploymentHashFor(change)).not.toBe(deploymentHashFor(envelope));
    }
  });

  it("treats an absent schema and an explicit null the same", () => {
    const envelope = baseEnvelope();
    const withoutSchemas: FunctionEnvelope = { ...envelope };
    delete withoutSchemas.paramsSchema;
    delete withoutSchemas.outputSchema;

    expect(deploymentHashFor(withoutSchemas)).toBe(
      deploymentHashFor({ ...envelope, paramsSchema: undefined, outputSchema: undefined }),
    );
    expect(deploymentHashFor(withoutSchemas)).not.toBe(deploymentHashFor(envelope));
  });

  it("ignores the upload timestamp and a signature", () => {
    const envelope = baseEnvelope();

    expect(deploymentHashFor({ ...envelope, version: "2030-01-01T00:00:00.000Z" })).toBe(
      deploymentHashFor(envelope),
    );
    expect(deploymentHashFor({ ...envelope, signature: "sig" })).toBe(deploymentHashFor(envelope));
  });

  it("pins the payload so a change has to bump the hash version", () => {
    // If this fails, the hashed payload changed. Old rows would now compare as
    // different and redeploy, which is safe; bump DEPLOYMENT_HASH_VERSION so
    // that intent is explicit and rows stay distinguishable across the change.
    expect(deploymentHashFor(baseEnvelope())).toBe(
      "sha256:d836ee94b825c17550f388c7ce6a6f225f46a360fa0582eab6b15ead768c6444",
    );
  });
});
