/**
 * The application schema every write fixture is bundled with.
 *
 * A deployed function file imports the app's schema the same way and
 * re-exports it, which is how the runner's `ctx` gets its registry. The
 * entity and relationship names here are the ones the Elixir write
 * acceptance tests seed and assert on.
 */

import { defineModel, defineRelationship, defineSchema, e } from "@ebbjs/schema";

const todo = defineModel("todo", {
  title: e.string(),
  done: e.boolean().default(false),
  // The canonical FK set a many-cardinality relationship writes on the source.
  labels: e.array(e.string()).default([]),
});
const project = defineModel("project", { name: e.string() });
const label = defineModel("label", { name: e.string() });

export const schema = defineSchema({
  models: { todo, project, label },
  relationships: {
    todo_project: defineRelationship({ source: todo, target: project, as: "project" }),
    todo_labels: defineRelationship({
      source: todo,
      target: label,
      as: "labels",
      sourceCardinality: "many",
    }),
  },
  version: 1,
});
