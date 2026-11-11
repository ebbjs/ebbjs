import { describe, expect, it } from "vitest";
import { decode as rawDecode } from "@msgpack/msgpack";
import { encode, decode, encodeSync, decodeSync } from "./index";

/** An HLC small enough to survive a round trip through a double. */
const SAFE_HLC = "1234567890123";
/** A real packed HLC (`ms << 16`), which exceeds `Number.MAX_SAFE_INTEGER`. */
const PACKED_HLC = "112134507724800000";

const codecs = [
  { name: "async", encode, decode },
  { name: "sync", encode: encodeSync, decode: decodeSync },
];

describe.each(codecs)("$name codec", ({ encode, decode }) => {
  it("puts an HLC that fits a double on the wire as an integer", async () => {
    const bytes = await encode({ hlc: SAFE_HLC });

    expect(rawDecode(bytes)).toEqual({ hlc: 1234567890123 });
    expect(await decode(bytes)).toEqual({ hlc: SAFE_HLC });
  });

  it("leaves a packed HLC over MAX_SAFE_INTEGER on the wire as its string", async () => {
    const bytes = await encode({ hlc: PACKED_HLC });

    expect(rawDecode(bytes)).toEqual({ hlc: PACKED_HLC });
    expect(await decode(bytes)).toEqual({ hlc: PACKED_HLC });
  });

  it("keeps non-HLC data and field structure intact", async () => {
    const original = {
      action: {
        id: "a_test",
        actor_id: "a_me",
        data: {
          map: {
            a: { value: 1, update_id: "u_a", hlc: SAFE_HLC },
            b: { value: ["x", false], update_id: "u_b" },
          },
        },
      },
    };

    expect(await decode(await encode(original))).toEqual(original);
  });
});
