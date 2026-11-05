/** Error text for a value a handler (or a transport) threw. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
