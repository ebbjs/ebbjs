/**
 * `@ebbjs/server`'s seed entry point. The implementation is shared with
 * the browser-safe `@ebbjs/client/seed` module; these are re-exports so
 * `@ebbjs/server`'s public names and signatures are unchanged.
 */

export {
  buildSeedAction,
  seed,
  assertSeedAccepted,
  isToleratedSeedRejection,
  SeedRejectedError,
  TOLERATED_SEED_REJECTIONS,
} from "@ebbjs/client/seed";

export type {
  GroupSeed,
  GroupMemberSeed,
  EntitySeed,
  RelationshipSeed,
  EntityGroupSeed,
  SeedData,
  Action,
} from "./types";
