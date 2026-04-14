import { parse } from "./pack.js";

export function compare(a: string, b: string): -1 | 0 | 1 {
  const aBig = parse(a);
  const bBig = parse(b);

  if (aBig < bBig) return -1;
  if (aBig > bBig) return 1;
  return 0;
}

export function isBefore(a: string, b: string): boolean {
  return compare(a, b) === -1;
}

export function isAfter(a: string, b: string): boolean {
  return compare(a, b) === 1;
}
