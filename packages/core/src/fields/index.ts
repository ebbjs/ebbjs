/**
 * @ebbjs/core field type markers.
 *
 * Re-exported from `@ebbjs/core`. The marker objects describe how a field
 * is merged when concurrent Updates collide. The actual merge algorithms
 * live in the appropriate package (e.g., `@ebbjs/client` for the
 * causal-tree field type).
 */
export { e, collaborativeTextFieldMarker } from "./collaborative-text";
