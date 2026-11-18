import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { decodeFrames, encodeFrame } from "./codec.ts";
import { ready } from "./constructors.ts";
import {
  LOG_LEVELS,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  RESULT_KINDS,
  type Frame,
} from "./frames.ts";

/// Resolved from this module rather than the cwd, so the run's directory does not matter.
const FIXTURE_DIR = fileURLToPath(new URL("../../../fixtures/functions/frames/", import.meta.url));

interface FixtureStep {
  readonly send?: Frame;
  readonly expect?: Frame;
  readonly exit?: string;
  readonly script?: unknown;
}

interface Fixture {
  readonly name: string;
  readonly description: string;
  readonly notes?: string;
  readonly steps: FixtureStep[];
}

const STEP_KEYS = ["send", "expect", "exit", "script"] as const;

/// The constants fixture carries values, not steps, so the frame sweep skips it.
const CONSTANTS_FIXTURE = "constants";

interface ConstantsFixture {
  readonly max_frame_bytes: number;
  readonly protocol_version: number;
  readonly result_kinds: readonly string[];
  readonly log_levels: readonly string[];
  readonly log_levels_by_peer: Readonly<Record<string, readonly string[]>>;
}

function fixtureNames(): string[] {
  return readdirSync(FIXTURE_DIR)
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -".json".length))
    .filter((name) => name !== CONSTANTS_FIXTURE)
    .sort();
}

function loadFixture(name: string): Fixture {
  const parsed: unknown = JSON.parse(readFileSync(`${FIXTURE_DIR}${name}.json`, "utf8"));

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`${name}.json is not a JSON object`);
  }

  return parsed as Fixture;
}

function framesIn(step: FixtureStep): Frame[] {
  const frames: Frame[] = [];

  if (step.send !== undefined) frames.push(step.send);
  if (step.expect !== undefined) frames.push(step.expect);

  return frames;
}

function stepKeys(step: FixtureStep): string[] {
  return STEP_KEYS.filter((key) => key in step);
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

function loadConstants(): ConstantsFixture {
  const parsed: unknown = JSON.parse(
    readFileSync(`${FIXTURE_DIR}${CONSTANTS_FIXTURE}.json`, "utf8"),
  );

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`${CONSTANTS_FIXTURE}.json is not a JSON object`);
  }

  return parsed as ConstantsFixture;
}

/** Encodes, decodes, and re-encodes `frame`, asserting nothing changed on the way. */
function assertRoundTrip(frame: Frame): Frame {
  const bytes = encodeFrame(frame);
  const decoded = decodeFrames(bytes);

  if (!decoded.ok) throw new Error(`fixture frame did not decode: ${decoded.error.kind}`);
  expect(decoded.frames).toHaveLength(1);
  expect(decoded.rest).toEqual(new Uint8Array());

  const [roundTripped] = decoded.frames;
  expect(roundTripped).toEqual(frame);
  expect(Object.keys(roundTripped)).toEqual(Object.keys(frame));
  expect(Array.from(encodeFrame(roundTripped))).toEqual(Array.from(bytes));

  return roundTripped;
}

describe("checked-in fixtures", () => {
  const names = fixtureNames();

  it("finds fixtures", () => {
    expect(names.length).toBeGreaterThan(0);
  });

  it.each(names)("%s names itself and starts with ready", (name) => {
    const fixture = loadFixture(name);

    expect(fixture.name).toBe(name);
    expect(typeof fixture.description).toBe("string");
    expect(fixture.steps[0]?.send?.type).toBe("ready");
  });

  it.each(names)("%s has one action per step", (name) => {
    for (const step of loadFixture(name).steps) {
      expect(stepKeys(step)).toHaveLength(1);
    }
  });

  it.each(names)("%s round-trips every send and expect frame", (name) => {
    const frames = loadFixture(name).steps.flatMap(framesIn);

    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) assertRoundTrip(frame);
  });

  it.each(names)("%s decodes with every frame buffered together", (name) => {
    const frames = loadFixture(name).steps.flatMap(framesIn);
    const decoded = decodeFrames(Buffer.concat(frames.map((frame) => encodeFrame(frame))));

    expect(decoded.ok && decoded.frames).toEqual(frames);
    if (!decoded.ok) throw new Error(`${name} did not decode: ${decoded.error.kind}`);
    expect(decoded.rest).toEqual(new Uint8Array());
  });

  it("the canonical ready frame matches the constructor", () => {
    const [first] = loadFixture("get-then-commit").steps;
    const canonical = first?.send;

    if (canonical === undefined || typeof canonical.pid !== "number") {
      throw new Error("get-then-commit does not start with a ready frame with a pid");
    }

    expect(
      ready(canonical.pid, String(canonical.runner_version), Number(canonical.protocol_version)),
    ).toEqual(canonical);
  });
});

describe("shared constants", () => {
  const constants = loadConstants();

  it("pins the frame bound and protocol version the Elixir host also hard-codes", () => {
    expect(MAX_FRAME_BYTES).toBe(constants.max_frame_bytes);
    expect(PROTOCOL_VERSION).toBe(constants.protocol_version);
  });

  it("pins the result kinds the runner emits and the host maps", () => {
    expect(sorted(RESULT_KINDS)).toEqual(sorted(constants.result_kinds));
  });

  it("pins this peer's log levels and covers the union both peers accept", () => {
    const typescript = constants.log_levels_by_peer["typescript"];
    const elixir = constants.log_levels_by_peer["elixir"];

    expect(typescript).toBeDefined();
    expect(elixir).toBeDefined();
    expect(sorted(LOG_LEVELS)).toEqual(sorted(typescript ?? []));
    expect(sorted([...new Set([...(typescript ?? []), ...(elixir ?? [])])])).toEqual(
      sorted(constants.log_levels),
    );
  });
});
