import type { ResolvedConfig } from "./config.ts";
import type { FunctionEnvelope } from "./envelope.ts";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiOptions {
  fetchImpl?: FetchLike;
}

export type ApiOptionsInput = ApiOptions;

export interface UploadVersionInput {
  envelope: FunctionEnvelope;
  code: string;
  pinned?: boolean;
}

export interface UploadVersionResponse {
  ok: true;
  name: string;
  version: string;
  status: string;
  pinned: boolean;
}

export interface ActivateVersionResponse {
  ok: true;
  name: string;
  version: string;
  status: string;
}

export interface FunctionSummary {
  name: string;
  version: string;
  access: string;
  paramsSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

export interface ListFunctionsResponse {
  functions: FunctionSummary[];
}

export interface VersionSummary {
  version: string;
  status: string;
  createdAt: string;
  activatedAt?: string;
  pinned: boolean;
  createdBy: string;
}

export interface ListVersionsResponse {
  versions: VersionSummary[];
}

/**
 * A request the server refused, or a response the CLI could not read.
 *
 * `code` is the server's `{error}` string when it sent one; `details` and
 * `issues` carry the rest of the error body so a caller can print something
 * useful without knowing each route's shape.
 */
export class CliHttpError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly details: unknown;
  readonly issues: unknown;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    const code = isRecord(body) && typeof body.error === "string" ? body.error : undefined;
    const details = isRecord(body) ? body.details : body;
    const issues = isRecord(body) ? body.issues : undefined;
    const suffix = describeDetails(details);

    super(`HTTP ${status}${code ? ` ${code}` : ""}${suffix ? `: ${suffix}` : ""}`);
    this.name = "CliHttpError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.issues = issues;
    this.body = body;
  }
}

export class MissingAdminTokenError extends Error {
  constructor() {
    super(
      "an admin token is required for this command; set `token` in ebb.config.ts or pass --token",
    );
    this.name = "MissingAdminTokenError";
  }
}

export async function uploadVersion(
  config: ResolvedConfig,
  name: string,
  input: UploadVersionInput,
  options: ApiOptionsInput = {},
): Promise<UploadVersionResponse> {
  return request<UploadVersionResponse>(
    config,
    "admin",
    "POST",
    `/functions/${encodeURIComponent(name)}/versions`,
    { envelope: input.envelope, code: input.code, pinned: input.pinned ?? false },
    options,
  );
}

export async function activateVersion(
  config: ResolvedConfig,
  name: string,
  version: string,
  options: ApiOptionsInput = {},
): Promise<ActivateVersionResponse> {
  return request<ActivateVersionResponse>(
    config,
    "admin",
    "POST",
    `/functions/${encodeURIComponent(name)}/activate`,
    { version },
    options,
  );
}

export async function rollback(
  config: ResolvedConfig,
  name: string,
  options: ApiOptionsInput = {},
): Promise<ActivateVersionResponse> {
  return request<ActivateVersionResponse>(
    config,
    "admin",
    "POST",
    `/functions/${encodeURIComponent(name)}/rollback`,
    undefined,
    options,
  );
}

export async function disable(
  config: ResolvedConfig,
  name: string,
  options: ApiOptionsInput = {},
): Promise<ActivateVersionResponse> {
  return request<ActivateVersionResponse>(
    config,
    "admin",
    "POST",
    `/functions/${encodeURIComponent(name)}/disable`,
    undefined,
    options,
  );
}

export async function listFunctions(
  config: ResolvedConfig,
  options: ApiOptionsInput = {},
): Promise<ListFunctionsResponse> {
  return request<ListFunctionsResponse>(config, "actor", "GET", "/functions", undefined, options);
}

export async function listVersions(
  config: ResolvedConfig,
  name: string,
  options: ApiOptionsInput = {},
): Promise<ListVersionsResponse> {
  return request<ListVersionsResponse>(
    config,
    "admin",
    "GET",
    `/functions/${encodeURIComponent(name)}/versions`,
    undefined,
    options,
  );
}

type RequestKind = "admin" | "actor";
type Method = "GET" | "POST";

async function request<T>(
  config: ResolvedConfig,
  kind: RequestKind,
  method: Method,
  path: string,
  body: unknown,
  options: ApiOptionsInput,
): Promise<T> {
  if (kind === "admin" && !config.token) throw new MissingAdminTokenError();

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const headers = requestHeaders(config, kind);
  if (body !== undefined) headers["content-type"] = "application/json";

  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);

  const response = await fetchImpl(endpoint(config.url, path), init);
  const parsed = await readJson(response);

  if (!response.ok) throw new CliHttpError(response.status, parsed);
  return parsed as T;
}

function requestHeaders(config: ResolvedConfig, kind: RequestKind): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (config.headers) Object.assign(headers, config.headers);

  if (config.actor) headers["x-ebb-actor-id"] = config.actor;
  if (kind === "admin") headers.authorization = `Bearer ${config.token}`;
  return headers;
}

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.trim() === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function describeDetails(details: unknown): string {
  if (details === undefined || details === null) return "";
  if (typeof details === "string") return details;
  try {
    return JSON.stringify(details);
  } catch {
    return String(details);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
