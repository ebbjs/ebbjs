import { describe, expect, it } from "vitest";
import { decode as rawDecode } from "@msgpack/msgpack";
import { encode, decode, encodeSync, decodeSync } from "./index";

/** A real packed HLC (`ms << 16`), which exceeds `Number.MAX_SAFE_INTEGER`. */
const PACKED_HLC = "112134507724800000";

const codecs = [
  { name: "async", encode, decode },
  { name: "sync", encode: encodeSync, decode: decodeSync },
];

describe.each(codecs)("$name codec", ({ encode, decode }) => {
  it("puts a real HLC on the wire as the decimal string it is", async () => {
    const bytes = await encode({ hlc: PACKED_HLC });

    expect(rawDecode(bytes)).toEqual({ hlc: PACKED_HLC });
    expect(await decode(bytes)).toEqual({ hlc: PACKED_HLC });
  });

  it("round-trips a large number and a long digit string without retyping either", async () => {
    const original = {
      updates: [
        {
          component: "note/due",
          data: { value: 1_700_000_000_000, update_id: "u_due", hlc: PACKED_HLC },
        },
        {
          component: "note/phone",
          data: { value: "15551234567", update_id: "u_phone", hlc: PACKED_HLC },
        },
      ],
    };

    const bytes = await encode(original);

    expect(rawDecode(bytes)).toEqual(original);

    const decoded = await decode<typeof original>(bytes);
    expect(decoded).toEqual(original);
    expect(typeof decoded.updates[0].data.value).toBe("number");
    expect(typeof decoded.updates[1].data.value).toBe("string");
  });

  it("keeps non-HLC data and field structure intact", async () => {
    const original = {
      action: {
        id: "a_test",
        actor_id: "a_me",
        data: {
          map: {
            a: { value: 1, update_id: "u_a", hlc: PACKED_HLC },
            b: { value: ["x", false], update_id: "u_b" },
          },
        },
      },
    };

    expect(await decode(await encode(original))).toEqual(original);
  });
});
