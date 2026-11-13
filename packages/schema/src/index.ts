/**
 * `@ebbjs/schema` — pure model, component, relationship, and schema definitions.
 *
 * The registry and validation the write planner and the sync client both
 * consume, plus the cell schemas a collaborative-text document entity
 * declares. No storage, no network, no client.
 */

export * from "./model";
export * from "./model-registry";
export * from "./migrations";
export * from "./relationship";
export * from "./reserved";
export * from "./schema";
export * from "./system-entities";
export * from "./collaborative-text/schema";
export * from "./collaborative-text/wire";
export * from "./collaborative-text/tree";
export {
  TextDocument,
  TextDocumentRegistry,
  type AppliedUpdate,
  type LocalDeleteOptions,
  type LocalExtendOptions,
  type LocalInsertOptions,
  type TextDocumentSubmit,
  type UpdateListener,
} from "./collaborative-text/text-document";
