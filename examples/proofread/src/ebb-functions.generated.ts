// src/ebb-functions.generated.ts — emitted by `ebb deploy` / `ebb functions types`
import { functionContract } from "@ebbjs/client";
import type { proofreadDocument } from "../functions/proofreadDocument";

export const functions = {
  proofreadDocument: functionContract<typeof proofreadDocument>("proofreadDocument"),
};
