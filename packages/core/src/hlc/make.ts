import { pack } from "./pack";
import { format } from "./pack";

// Packed BigInt HLC at (`ms << 16 | counter`), returned as a decimal string.
// Mirrors what `localEvent(clock)` produces for a clock pinned at `ms`,
// useful for tests that need a deterministic fixture.
export function makeHlc(ms: number | bigint, counter: number | bigint = 0): string {
  return format(pack(BigInt(ms), BigInt(counter)));
}
