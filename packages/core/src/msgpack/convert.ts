import { parse, format } from "../hlc/pack.js";

export function hlcToInteger(hlc: string): number {
  return Number(parse(hlc));
}

export function integerToHLC(n: number): string {
  return format(BigInt(n));
}

export function convertHlcToInteger<T>(value: T): T {
  if (typeof value === "string") {
    if (/^\d+$/.test(value) && value.length > 10) {
      return hlcToInteger(value) as T;
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((v) => convertHlcToInteger(v)) as T;
  }

  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = convertHlcToInteger(v);
    }
    return result as T;
  }

  return value;
}

export function convertIntegerToHlc<T>(value: T): T {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    if (value > 1_000_000_000_000) {
      return format(BigInt(value)) as T;
    }
    return value;
  }

  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((v) => convertIntegerToHlc(v)) as T;
  }

  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = convertIntegerToHlc(v);
    }
    return result as T;
  }

  return value;
}
