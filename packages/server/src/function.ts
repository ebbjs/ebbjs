import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Context } from "./context";
import type { FunctionSchema } from "./schema";

export interface FunctionOptions<O = unknown> {
  /** `granted` requires the `function.<name>` grant; `authenticated` only a principal. */
  access?: "granted" | "authenticated";
  timeoutMs?: number;
  memoryMb?: number;
  /** When present, the server checks the handler's result against this schema. */
  output?: FunctionSchema<O>;
}

export interface FunctionDef<S, I, O> {
  schema: S;
  params: FunctionSchema<I> | undefined;
  output?: FunctionSchema<O>;
  handler: (ctx: Context<S>, params: I) => O | Promise<O>;
  access: "granted" | "authenticated";
  timeoutMs?: number;
  memoryMb?: number;
  /** Type-only markers; never present at runtime. */
  "~input"?: I;
  "~output"?: O;
}

export function defineFunction<S, P extends FunctionSchema<any>, R>(
  schema: S,
  params: P,
  handler: (ctx: Context<S>, params: StandardSchemaV1.InferOutput<P>) => R,
  options?: FunctionOptions<Awaited<R>>,
): FunctionDef<S, StandardSchemaV1.InferOutput<P>, Awaited<R>>;
export function defineFunction<S, R>(
  schema: S,
  handler: (ctx: Context<S>) => R,
  options?: FunctionOptions<Awaited<R>>,
): FunctionDef<S, void, Awaited<R>>;
export function defineFunction<S, I, O>(
  schema: S,
  paramsOrHandler: FunctionSchema<I> | ((ctx: Context<S>, params: I) => O | Promise<O>),
  handlerOrOptions?: ((ctx: Context<S>, params: I) => O | Promise<O>) | FunctionOptions<O>,
  maybeOptions?: FunctionOptions<O>,
): FunctionDef<S, I, O> {
  const hasParams = typeof paramsOrHandler !== "function";
  const params = hasParams ? paramsOrHandler : undefined;
  const handler = (hasParams ? handlerOrOptions : paramsOrHandler) as (
    ctx: Context<S>,
    params: I,
  ) => O | Promise<O>;
  const options = (hasParams ? maybeOptions : handlerOrOptions) as FunctionOptions<O> | undefined;
  return {
    schema,
    params,
    output: options?.output,
    handler,
    access: options?.access ?? "granted",
    timeoutMs: options?.timeoutMs,
    memoryMb: options?.memoryMb,
  };
}
