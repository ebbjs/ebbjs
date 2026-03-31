/**
 * Collaborative Text Demo Components
 *
 * Barrel export for all the interactive components used in the
 * collaborative editing devlog/demo.
 */

// Main interactive components
export { DualEditors } from "./DualEditors.tsx"
export {
  EventLogSection,
  CausalTreeSection,
  HlcStateSection,
} from "./InspectorPanel.tsx"

// Re-export types that might be useful
export type { Hlc } from "./hlc.ts"
export type { DocState, RunNode } from "./causal-tree.ts"
export type { Action, Update, SyncMessage } from "./relay.ts"
