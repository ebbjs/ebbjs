/**
 * A pending debounce or TTL sweep must never be the reason a Node process
 * stays alive.
 */
export function unrefTimer(handle: ReturnType<typeof setTimeout>): void {
  const maybe = handle as unknown as { unref?: () => void };
  if (typeof maybe.unref === "function") maybe.unref();
}
