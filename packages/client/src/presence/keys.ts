/**
 * Map keys for the presence transport and store. Both halves scope work by
 * the same `(entity, channel)` pair, so they must agree on how it is joined
 * into a string.
 */

const SEP = "\u0000";

/** The `(entity, channel)` pair: one presence target. */
export const targetKey = (entityId: string, channel: string): string =>
  `${entityId}${SEP}${channel}`;

/** One observed peer: a target plus the actor that sent on it. */
export const entryKey = (entityId: string, channel: string, actorId: string): string =>
  `${targetKey(entityId, channel)}${SEP}${actorId}`;
