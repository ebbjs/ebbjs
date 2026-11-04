/**
 * Typed invocation of deployed functions.
 *
 * `ebb deploy` emits a contract map that imports each function's definition
 * as a *type* and calls {@link functionContract} with its deployed name, so
 * `createClient({ functions })` types `client.functions.<name>` the way it
 * types `client.actions`, with no `@ebbjs/server` code in the client bundle.
 */

/**
 * The structural slice of a `FunctionDef` this package reads: the type-only
 * `~input` / `~output` markers `defineFunction` declares. Neither exists at
 * runtime, which is what lets the generated map stay type-only.
 */
export interface FunctionDefLike {
  readonly "~input"?: unknown;
  readonly "~output"?: unknown;
}

/** Params a definition declares; `void` when it declares none. */
export type FunctionInput<D> = D extends { readonly "~input"?: infer I } ? I : void;

/** Result a definition declares. */
export type FunctionOutput<D> = D extends { readonly "~output"?: infer O } ? O : unknown;

/**
 * One entry of the generated contract map: the wire name plus the
 * definition's marker types. `functionContract` is the only constructor.
 */
export interface FunctionContract<I, O> {
  /** The deployed name, exactly as the server's `/functions/:name` expects it. */
  readonly name: string;
  /** Type-only marker, mirroring `FunctionDef["~input"]`. */
  readonly "~input"?: I;
  /** Type-only marker, mirroring `FunctionDef["~output"]`. */
  readonly "~output"?: O;
}

/** A contract with its input/output erased: the bound of a contract map. */
export type AnyFunctionContract = FunctionContract<any, any>;

/**
 * Build a contract-map entry from a definition's type.
 *
 * The runtime value is the name alone; `D` is erased with the type-only
 * import that supplied it.
 */
export function functionContract<D extends FunctionDefLike>(
  name: string,
): FunctionContract<FunctionInput<D>, FunctionOutput<D>> {
  return { name };
}

/** Per-invocation options. */
export interface FunctionCallOptions {
  /**
   * Deduplicates a retried invocation: the server derives the invocation id
   * — and so the Action id — from actor, function name, and this key, then
   * replays the first attempt's outcome instead of writing again.
   *
   * The caller supplies it. A key claims "this is the same request", which
   * only the caller knows, so the client never invents one per call.
   */
  readonly idempotencyKey?: string;
}

/** One successful invocation, as `POST /functions/:name` returns it. */
export interface FunctionCallResult<O> {
  readonly result: O;
  /** The commit was already durable, so this invocation assigned no GSN. */
  readonly replayed: boolean;
}

/**
 * What `client.functions.<name>` resolves to. An object result is spread
 * into the resolved value so callers read its fields directly; anything else
 * arrives under `result`. A void result carries `replayed` alone.
 */
export type FunctionReturn<O> = [O] extends [void]
  ? { readonly replayed: boolean }
  : O extends readonly unknown[] | ((...args: never[]) => unknown)
    ? FunctionCallResult<O>
    : O extends object
      ? O & { readonly replayed: boolean }
      : FunctionCallResult<O>;

/** One validation issue, dotted `path` included, from a `400` / `422` body. */
export interface FunctionIssue {
  readonly path: string;
  readonly message: string;
}

/**
 * The failure envelope of `POST /functions/:name`: `error` is the code,
 * `details` text for a person, and `issues` the structured validation list.
 * `invocation_id` and `version` name the attempt and the bundle that served
 * it; both are absent when the server never resolved either.
 */
export interface FunctionErrorEnvelope {
  readonly error?: string;
  readonly details?: string;
  readonly issues?: readonly FunctionIssue[];
  readonly invocation_id?: string;
  readonly version?: string;
}

/**
 * An invocation the server refused for any reason but a rejected commit.
 * `422 error: "rejected"` is the write path's answer and surfaces as
 * `ActionRejectedError`, carrying the same rejection list a rejected batch
 * does; everything else — an unknown function, a denied caller, invalid
 * params, a handler failure — is one of these.
 */
export class FunctionCallError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: string | undefined;
  readonly issues: readonly FunctionIssue[] | undefined;
  readonly invocationId: string | undefined;
  readonly version: string | undefined;

  constructor(status: number, envelope: FunctionErrorEnvelope = {}) {
    const code = envelope.error ?? "unknown_error";
    super(formatFunctionCallError(status, code, envelope.details));
    this.name = "FunctionCallError";
    this.status = status;
    this.code = code;
    this.details = envelope.details;
    this.issues = envelope.issues;
    this.invocationId = envelope.invocation_id;
    this.version = envelope.version;
  }
}

const formatFunctionCallError = (status: number, code: string, details?: string): string => {
  const headline = `FunctionCallError: ${status} ${code}`;
  return details === undefined || details === "" ? headline : `${headline} (${details})`;
};

/**
 * Shape an invocation result for `client.functions.<name>`. The runtime
 * branch mirrors {@link FunctionReturn}: a plain object spreads, a void
 * result leaves only `replayed`, and everything else keeps its `result` slot.
 */
export const toFunctionReturn = <O>(result: O, replayed: boolean): FunctionReturn<O> => {
  if (typeof result === "object" && result !== null && !Array.isArray(result)) {
    // SAFETY: the branch above is exactly the object arm of `FunctionReturn`.
    return { ...result, replayed } as FunctionReturn<O>;
  }
  if (result === undefined) {
    // SAFETY: the void arm of `FunctionReturn` is `{ replayed }`.
    return { replayed } as FunctionReturn<O>;
  }
  return { result, replayed } as FunctionReturn<O>;
};

/** What a mounted `client.functions.<name>` takes and resolves to. */
export type BoundFunction<C> =
  FunctionInput<C> extends void
    ? (
        input?: undefined,
        options?: FunctionCallOptions,
      ) => Promise<FunctionReturn<FunctionOutput<C>>>
    : (
        input: FunctionInput<C>,
        options?: FunctionCallOptions,
      ) => Promise<FunctionReturn<FunctionOutput<C>>>;

/**
 * The `client.functions` surface, keyed by the contract map's keys.
 *
 * A bare `Record<string, …>` is what `ReturnType<typeof createClient>`
 * instantiates the map's generic to; it is not a concrete map, so it adds no
 * `functions` property. A generated map has literal keys and always does.
 */
export type FunctionsNamespace<TFunctions extends Record<string, AnyFunctionContract>> =
  string extends keyof TFunctions
    ? Record<never, never>
    : {
        readonly functions: {
          [K in keyof TFunctions]: BoundFunction<TFunctions[K]>;
        };
      };
