/**
 * Composite keys over strings.
 *
 * Several in-memory maps are keyed by a tuple: a subject and its component,
 * a component and the two versions it migrates between, a surface and its
 * query. Joining the parts with a separator is cheaper than nesting maps,
 * but a bare join is ambiguous — a part that itself contains the separator
 * makes two distinct tuples spell one key, and the map then answers for the
 * wrong entry. So a part is escaped before it is joined, and a key is one
 * spelling of exactly one tuple.
 *
 * These keys live in memory only; nothing encodes or persists them, so the
 * escaping is free to change the characters.
 */

/** Between the parts of one key. */
export const KEY_SEP = "\u0000";

/** Between the segments of one ordered list part (a field path). */
export const PATH_SEP = "\u0001";

/**
 * A part as it may appear inside a key: the escape character doubled, each
 * separator written as its escape and digit. The escapes are themselves
 * unambiguous, so the join is injective.
 */
const escapePart = (part: string): string =>
  part.replaceAll("\\", "\\\\").replaceAll(KEY_SEP, "\\0").replaceAll(PATH_SEP, "\\1");

/** One part of a key: a single string, or an ordered list of them. */
export type KeyPart = string | readonly string[];

const encodePart = (part: KeyPart): string =>
  typeof part === "string" ? escapePart(part) : part.map(escapePart).join(PATH_SEP);

/** The key for one tuple of parts. */
export const keyOf = (...parts: readonly KeyPart[]): string => parts.map(encodePart).join(KEY_SEP);
