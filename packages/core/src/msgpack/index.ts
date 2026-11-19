import { encode as msgpackEncode, decode as msgpackDecode } from "@msgpack/msgpack";

export async function encode<T>(value: T): Promise<Uint8Array> {
  return msgpackEncode(value);
}

export async function decode<T>(data: Uint8Array): Promise<T> {
  return (await msgpackDecode(data)) as T;
}

export function encodeSync<T>(value: T): Uint8Array {
  return msgpackEncode(value);
}

export function decodeSync<T>(data: Uint8Array): T {
  return msgpackDecode(data) as T;
}

export default { encode, decode, encodeSync, decodeSync };
