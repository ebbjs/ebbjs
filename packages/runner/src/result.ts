/**
 * The `result` frame, bounded before it is written.
 *
 * A value the codec cannot fit in one frame is an invocation outcome, not a
 * transport failure: the runner sends a small `output_too_large` result and
 * keeps the process alive for the host's next `invoke`, instead of handing the
 * host a frame it would refuse from its length prefix.
 */

import { encodeFrame, MAX_FRAME_BYTES, result, type ResultFrame } from "@ebbjs/functions-protocol";

/** What one invocation ended as, before it is framed. */
export type ResultOutcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly kind: string; readonly message: string };

/**
 * Builds the frame to send, within `maxOutputBytes`.
 *
 * `max_output_bytes` bounds the handler's value. The failure frames are bounded
 * by the protocol's frame bound alone: a host that states a pathological cap
 * still gets a diagnosable result instead of nothing. An oversize success
 * becomes `output_too_large` with a message that says how to fix it; an
 * oversize failure keeps its kind and clips its message, because the kind is
 * the part the host's error taxonomy maps.
 */
export function boundedResultFrame(
  outcome: ResultOutcome,
  maxOutputBytes: number = MAX_FRAME_BYTES,
): ResultFrame {
  const frame = result(outcome);

  if (outcome.ok) {
    const bound = Math.min(maxOutputBytes, MAX_FRAME_BYTES);
    if (frameBytes(frame) <= bound) return frame;

    return result({
      ok: false,
      kind: "output_too_large",
      message:
        `invocation output exceeds the ${bound}-byte result frame limit; ` +
        "return less data, or write it as an entity and return an id",
    });
  }

  if (frameBytes(frame) <= MAX_FRAME_BYTES) return frame;

  const clipped = result({
    ok: false,
    kind: outcome.kind,
    message: outcome.message.slice(0, MAX_FRAME_BYTES - FRAME_OVERHEAD_BYTES),
  });

  return frameBytes(clipped) <= MAX_FRAME_BYTES
    ? clipped
    : result({ ok: false, kind: outcome.kind, message: "error message too large to frame" });
}

/** Bytes left for a message once the frame envelope itself is counted. */
const FRAME_OVERHEAD_BYTES = 256;

function frameBytes(frame: ResultFrame): number {
  return encodeFrame(frame).length;
}
