export function isValidHLC(hlc: string): boolean {
  if (!hlc || typeof hlc !== "string") return false;
  if (hlc.length === 0) return false;

  if (!/^\d+$/.test(hlc)) return false;

  const n = BigInt(hlc);
  return n > 0n;
}
