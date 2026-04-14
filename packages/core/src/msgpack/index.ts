import { encode as msgpackEncode, decode as msgpackDecode } from "@msgpack/msgpack";
import { convertHlcToInteger, convertIntegerToHlc } from "./convert.js";

export async function encode<T>(value: T): Promise<Uint8Array> {
  const converted = convertHlcToInteger(value);
  return msgpackEncode(converted);
}

export async function decode<T>(data: Uint8Array): Promise<T> {
  const decoded = (await msgpackDecode(data)) as T;
  return convertIntegerToHlc(decoded);
}

export function encodeSync<T>(value: T): Uint8Array {
  const converted = convertHlcToInteger(value);
  return msgpackEncode(converted);
}

export function decodeSync<T>(data: Uint8Array): T {
  const decoded = msgpackDecode(data) as T;
  return convertIntegerToHlc(decoded);
}

export default { encode, decode, encodeSync, decodeSync };
