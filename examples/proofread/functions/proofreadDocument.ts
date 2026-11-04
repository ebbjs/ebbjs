import { defineFunction, p } from "@ebbjs/server";

import { schema } from "../src/schema";

/**
 * The external proofreading service this function calls.
 *
 * A deployed function reads endpoints and credentials from its own config; v1
 * keeps them in source, and #597 adds the per-function secrets/env channel.
 */
export const PROOFREAD_ENDPOINT = "https://proofread.example.invalid/v1/proofread";

/**
 * Reads one wire field as a string.
 *
 * `ctx.get` returns the entity in wire shape, so a leaf is `{ value, ... }`
 * rather than the projected value a query row carries.
 */
const stringField = (fields: Record<string, unknown>, name: string, documentId: string): string => {
  const leaf = fields[name];
  if (typeof leaf !== "object" || leaf === null || !("value" in leaf)) {
    throw new Error(`document ${documentId} has no "${name}" field`);
  }
  if (typeof leaf.value !== "string") {
    throw new Error(`document ${documentId} has a non-string "${name}" field`);
  }
  return leaf.value;
};

interface ProofreadReply {
  readonly comments?: unknown;
}

const requestProofreading = async (text: string): Promise<readonly string[]> => {
  const response = await fetch(PROOFREAD_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!response.ok) {
    throw new Error(`proofreading failed: ${response.status}`);
  }

  const reply = (await response.json()) as ProofreadReply;
  const comments = reply.comments;
  if (!Array.isArray(comments) || comments.some((comment) => typeof comment !== "string")) {
    throw new Error("proofreading failed: response carried no string comments");
  }
  return comments;
};

/**
 * Proofread one document and record the service's comments.
 *
 * External side effects are not rolled back: the service has already answered
 * when `ctx.create` runs, so a rejected commit or a deadline leaves the
 * comments written here unpersisted while the external call stands. The write
 * is the only part inside the Action. Keep this order — read, call, write —
 * rather than writing first and pretending the pairs are atomic.
 */
export const proofreadDocument = defineFunction(
  schema,
  p.object({
    documentId: p.string(),
    workspaceId: p.string(),
  }),
  async (ctx, params) => {
    const document = await ctx.get(params.documentId);
    if (document === null) {
      throw new Error(`document ${params.documentId} not found or not readable`);
    }
    const body = stringField(document.data.fields, "body", params.documentId);

    const comments = await requestProofreading(body);

    for (const commentBody of comments) {
      ctx.create(
        "comment",
        { documentId: params.documentId, body: commentBody },
        { groups: [params.workspaceId] },
      );
    }

    return { commentCount: comments.length };
  },
  // The external call dominates; leave it room inside the server's deadline.
  { timeoutMs: 15_000 },
);
