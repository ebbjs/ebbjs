/**
 * The frame codec shared by the host and the function runner.
 *
 * A frame on the wire is `<<byte_size::32, json::binary>>`, big-endian, with
 * `json` the UTF-8 encoding of the frame object. `decodeFrames` returns every
 * complete frame in the buffer plus the trailing partial bytes, so a transport
 * appends the rest to the next chunk and calls again. It never blocks and never
 * assumes a read boundary lines up with a frame.
 *
 * The frame bound is checked from the length prefix before the payload is
 * awaited, so an oversize frame is refused without being held in memory.
 */

import { type Frame, MAX_FRAME_BYTES } from "./frames.ts";

/** Bytes of the big-endian payload length that starts every frame. */
const HEADER_BYTES = 4;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** Why a buffer could not be decoded. Each kind mirrors an Elixir reason. */
export type DecodeError =
  | { readonly kind: "empty_frame" }
  | { readonly kind: "frame_too_large"; readonly length: number }
  | { readonly kind: "invalid_json"; readonly message: string }
  | { readonly kind: "invalid_frame"; readonly value: unknown };

/**
 * The outcome of decoding a buffer.
 *
 * `{ ok: true, frames, rest }` is every complete frame in arrival order and the
 * trailing bytes of an incomplete frame; `rest` is a copy, safe to append to.
 * `{ ok: false, error }` is the first failure, and the frames decoded before it
 * are dropped: a caller that sees an error must reset its buffer, not retry.
 */
export type DecodeResult =
  | { readonly ok: true; readonly frames: Frame[]; readonly rest: Uint8Array }
  | { readonly ok: false; readonly error: DecodeError };

type PayloadResult =
  | { readonly ok: true; readonly frame: Frame }
  | { readonly ok: false; readonly error: DecodeError };

/**
 * Encodes one frame, prefixing its JSON payload with its byte length.
 *
 * The bound is not enforced here, matching the Elixir side. A sender that may
 * exceed it checks the encoded length against `MAX_FRAME_BYTES`; a receiver
 * refuses an oversize frame from its prefix.
 */
export function encodeFrame(frame: Frame): Uint8Array {
  const payload = encoder.encode(JSON.stringify(frame));
  const bytes = new Uint8Array(HEADER_BYTES + payload.length);

  new DataView(bytes.buffer).setUint32(0, payload.length, false);
  bytes.set(payload, HEADER_BYTES);

  return bytes;
}

/**
 * Whether `frame` fits the frame bound once encoded, prefix included.
 *
 * The host measures an `invoke` before sending it; encoding to measure keeps
 * the bound in one place instead of letting a call site guess.
 */
export function fits(frame: Frame): boolean {
  return HEADER_BYTES + encoder.encode(JSON.stringify(frame)).length <= MAX_FRAME_BYTES;
}

/** Decodes every complete frame in `buffer`, plus the trailing partial bytes. */
export function decodeFrames(buffer: Uint8Array): DecodeResult {
  const frames: Frame[] = [];
  let offset = 0;

  while (buffer.length - offset >= HEADER_BYTES) {
    const length = new DataView(buffer.buffer, buffer.byteOffset + offset, HEADER_BYTES).getUint32(
      0,
      false,
    );

    if (length > MAX_FRAME_BYTES) return { ok: false, error: { kind: "frame_too_large", length } };
    if (length === 0) return { ok: false, error: { kind: "empty_frame" } };

    const start = offset + HEADER_BYTES;
    if (buffer.length - start < length) break;

    const decoded = decodePayload(buffer.subarray(start, start + length));
    if (!decoded.ok) return { ok: false, error: decoded.error };

    frames.push(decoded.frame);
    offset = start + length;
  }

  return { ok: true, frames, rest: copyBytes(buffer.subarray(offset)) };
}

/** A plain `Uint8Array` copy, even when the input was a `Buffer`. */
function copyBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

function decodePayload(payload: Uint8Array): PayloadResult {
  const text = decodeUtf8(payload);
  if (!text.ok) return { ok: false, error: { kind: "invalid_json", message: text.message } };

  const parsed = parseJson(text.value);
  if (!parsed.ok) return { ok: false, error: { kind: "invalid_json", message: parsed.message } };
  if (!isTypedFrame(parsed.value))
    return { ok: false, error: { kind: "invalid_frame", value: parsed.value } };

  return { ok: true, frame: parsed.value };
}

function decodeUtf8(
  payload: Uint8Array,
):
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly message: string } {
  try {
    return { ok: true, value: decoder.decode(payload) };
  } catch (error) {
    return { ok: false, message: messageOf(error) };
  }
}

function parseJson(
  text: string,
):
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, message: messageOf(error) };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A frame is a JSON object carrying a string `type`; anything else is refused. */
function isTypedFrame(value: unknown): value is Frame {
  return (
    typeof value === "object" && value !== null && "type" in value && typeof value.type === "string"
  );
}
