/** The errors unique to the invocation's write surface. */

/** A write verb was reached without a schema registry to resolve it against. */
export class MissingSchemaError extends Error {
  constructor() {
    super(
      'ctx writes require an entity schema: export a "schema" binding from the function bundle (the value defineSchema returns)',
    );
    this.name = "MissingSchemaError";
  }
}

/**
 * A write was attempted after the invocation's Action was submitted. One
 * invocation is one Action, so a later write has nowhere to go.
 */
export class WritesCommittedError extends Error {
  constructor() {
    super(
      "ctx writes are sealed: this invocation already committed its Action. " +
        "One invocation is one Action — buffer every write before ctx.commit(), " +
        "or let the runner flush at handler return.",
    );
    this.name = "WritesCommittedError";
  }
}
