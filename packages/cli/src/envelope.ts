import { createHash } from "node:crypto";

/** The bundle ABI this CLI emits and the server currently understands. */
export const CONTRACT_VERSION = 1;

export type FunctionAccess = "granted" | "authenticated";
export type FunctionsRuntime = "bun";

/** The camelCase envelope written beside `<name>@<version>.js`. */
export interface FunctionEnvelope {
  name: string;
  version: string;
  digest: string;
  signature?: string;
  runtime: FunctionsRuntime;
  contract: number;
  access: FunctionAccess;
  timeoutMs: number;
  memoryBytes: number;
  entry: string;
  paramsSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

export interface EnvelopeInput {
  name: string;
  version: string;
  code: string | Uint8Array;
  digest?: string;
  signature?: string;
  runtime?: FunctionsRuntime;
  contract?: number;
  access?: FunctionAccess;
  timeoutMs?: number;
  memoryBytes?: number;
  entry?: string;
  paramsSchema?: Record<string, unknown> | null;
  outputSchema?: Record<string, unknown> | null;
}

export interface EnvelopeProblem {
  field: string;
  message: string;
}

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MEMORY_BYTES = 268_435_456;
export const MAX_TIMEOUT_MS = 60_000;
export const MAX_NAME_LENGTH = 64;

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const ACCESS_VALUES: readonly FunctionAccess[] = ["granted", "authenticated"];
const RESERVED_NAMES = new Set(["default"]);

/** The canonical digest of a bundle's code bytes. */
export function digestFor(code: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(code).digest("hex")}`;
}

/** Whether `name` is a legal function binding name. */
export function isValidFunctionName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name.length <= MAX_NAME_LENGTH &&
    !RESERVED_NAMES.has(name) &&
    NAME_PATTERN.test(name)
  );
}

/** `<bundle_dir>/<name>@<version>.js`. */
export function codeFilename(name: string, version: string): string {
  return `${name}@${version}.js`;
}

/** `<bundle_dir>/<name>@<version>.envelope.json`. */
export function envelopeFilename(name: string, version: string): string {
  return `${name}@${version}.envelope.json`;
}

/**
 * Builds the envelope for a bundle, filling defaults and computing the digest
 * from the code unless the caller already supplied one.
 */
export function buildEnvelope(input: EnvelopeInput): FunctionEnvelope {
  const {
    name,
    version,
    code,
    digest,
    signature,
    runtime = "bun",
    contract = CONTRACT_VERSION,
    access = "granted",
    timeoutMs = DEFAULT_TIMEOUT_MS,
    memoryBytes = DEFAULT_MEMORY_BYTES,
    entry = name,
    paramsSchema,
    outputSchema,
  } = input;

  const envelope: FunctionEnvelope = {
    name,
    version,
    digest: digest ?? digestFor(code),
    runtime,
    contract,
    access,
    timeoutMs,
    memoryBytes,
    entry,
  };

  if (signature !== undefined) envelope.signature = signature;
  if (paramsSchema !== undefined && paramsSchema !== null) envelope.paramsSchema = paramsSchema;
  if (outputSchema !== undefined && outputSchema !== null) envelope.outputSchema = outputSchema;

  return envelope;
}

/**
 * Validates an envelope the server may have to load. The CLI uses this before
 * writing, and a test can use it to prove the emitted shape is acceptable.
 */
export function validateEnvelope(envelope: unknown): EnvelopeProblem[] {
  if (!isRecord(envelope)) {
    return [{ field: "envelope", message: "must be an object" }];
  }

  const problems: EnvelopeProblem[] = [];
  const add = (field: string, message: string) => problems.push({ field, message });

  if (!isValidFunctionName(envelope.name))
    add("name", "must be a JavaScript identifier of at most 64 characters and not `default`");

  if (!isNonEmptyString(envelope.version)) add("version", "must be a non-empty string");
  if (!isNonEmptyString(envelope.digest) || !DIGEST_PATTERN.test(envelope.digest as string)) {
    add("digest", "must be `sha256:` followed by 64 lowercase hex characters");
  }
  if (!isNonEmptyString(envelope.entry)) add("entry", "must be a non-empty string");
  else if (envelope.entry !== envelope.name) add("entry", "must equal the function name");

  if (envelope.runtime !== "bun") add("runtime", "must be `bun`");
  if (envelope.contract !== CONTRACT_VERSION) add("contract", `must be ${CONTRACT_VERSION}`);
  if (!ACCESS_VALUES.includes(envelope.access as FunctionAccess)) {
    add("access", "must be `granted` or `authenticated`");
  }

  if (
    !Number.isInteger(envelope.timeoutMs) ||
    (envelope.timeoutMs as number) <= 0 ||
    (envelope.timeoutMs as number) > MAX_TIMEOUT_MS
  ) {
    add("timeoutMs", `must be an integer between 1 and ${MAX_TIMEOUT_MS}`);
  }

  if (!Number.isInteger(envelope.memoryBytes) || (envelope.memoryBytes as number) <= 0) {
    add("memoryBytes", "must be a positive integer");
  }

  for (const field of ["paramsSchema", "outputSchema"] as const) {
    const value = envelope[field];
    if (value !== undefined && !isRecord(value)) add(field, "must be an object when present");
  }

  if (envelope.signature !== undefined && !isNonEmptyString(envelope.signature)) {
    add("signature", "must be a non-empty string when present");
  }

  return problems;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
