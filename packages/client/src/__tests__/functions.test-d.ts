import { describe, expectTypeOf, it } from "vitest";

import { createClient, functionContract, type FunctionContract, type SyncClient } from "../index";

/**
 * Hand-written stand-ins for `defineFunction`'s definition type. The real
 * contract map imports a definition as a type; only the phantom markers
 * matter here, so no `@ebbjs/server` import is needed to prove the
 * derivation.
 */
interface ProofreadDef {
  readonly "~input"?: { documentId: string; limit?: number };
  readonly "~output"?: { commentCount: number };
}

interface PingDef {
  readonly "~input"?: void;
  readonly "~output"?: string;
}

interface NoopDef {
  readonly "~input"?: void;
  readonly "~output"?: void;
}

const proofread = functionContract<ProofreadDef>("proofreadDocument");
const ping = functionContract<PingDef>("ping");
const noop = functionContract<NoopDef>("noop");

const client = createClient({
  serverUrl: "http://localhost:4000",
  actorId: "actor_1",
  functions: { proofread, ping, noop },
});

describe("functionContract types", () => {
  it("derives input and output from the definition's phantom markers", () => {
    expectTypeOf(proofread).toEqualTypeOf<
      FunctionContract<{ documentId: string; limit?: number }, { commentCount: number }>
    >();
    expectTypeOf(ping).toEqualTypeOf<FunctionContract<void, string>>();
    expectTypeOf(noop).toEqualTypeOf<FunctionContract<void, void>>();
    expectTypeOf(proofread.name).toEqualTypeOf<string>();
  });
});

describe("client.functions types", () => {
  it("takes the definition's input and spreads an object result", () => {
    expectTypeOf(client.functions.proofread)
      .parameter(0)
      .toEqualTypeOf<{ documentId: string; limit?: number }>();
    expectTypeOf(client.functions.proofread({ documentId: "d_1" })).toEqualTypeOf<
      Promise<{ commentCount: number } & { readonly replayed: boolean }>
    >();
  });

  it("omits the input for a void-params definition", () => {
    expectTypeOf(client.functions.ping()).toEqualTypeOf<
      Promise<{ readonly result: string; readonly replayed: boolean }>
    >();
    expectTypeOf(client.functions.ping(undefined, { idempotencyKey: "retry-1" })).toEqualTypeOf<
      Promise<{ readonly result: string; readonly replayed: boolean }>
    >();
  });

  it("keeps a void result as replayed alone", () => {
    expectTypeOf(client.functions.noop()).toEqualTypeOf<Promise<{ readonly replayed: boolean }>>();
  });

  it("leaves the functions map optional", () => {
    const plain = createClient({ serverUrl: "http://localhost:4000", actorId: "a_test" });

    expectTypeOf(plain).toMatchTypeOf<SyncClient>();
    // @ts-expect-error no map was passed, so there is no functions surface
    plain.functions;
  });

  it("does not require a functions property when the map is erased", () => {
    // `ReturnType<typeof createClient>` instantiates the map generic to its
    // constraint, not to the empty default. A bare SyncClient must still be
    // accepted, or props typed as `ReturnType<typeof createClient>` break.
    const acceptsErased = (value: ReturnType<typeof createClient>) => value;
    acceptsErased({} as SyncClient);
  });

  it("rejects params that do not match the definition", () => {
    // @ts-expect-error `documentId` is required
    client.functions.proofread({ limit: 2 });
    // @ts-expect-error `documentId` is a string
    client.functions.proofread({ documentId: 7 });
    // @ts-expect-error a void-params function takes no input
    client.functions.ping({ extra: true });
    // @ts-expect-error the first argument is input, not the options bag
    client.functions.proofread({ idempotencyKey: "retry-1" });
  });
});
