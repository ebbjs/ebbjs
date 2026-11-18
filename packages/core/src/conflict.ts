/**
 * Granularity at which a concurrent write is surfaced as a conflict.
 * `"field"` scopes detection to a shared map position; `"component"` holds
 * one component; `"entity"` surfaces any touch of an entity with offline
 * writes. A component declared `structural` opts out of detection entirely,
 * which is how the SDK's edge, membership, and grant rows behave.
 *
 * One declaration for the scope an app declares (`ModelRegistry`), the scope a
 * detected conflict persists (`OutboxConflict`), and the scope the catch-up
 * pass compares: adding a fourth value is a compile error at every one of
 * them, not a silently-rejected persisted shape.
 */
export type ConflictScope = "field" | "component" | "entity";
