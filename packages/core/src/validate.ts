import { Value } from "@sinclair/typebox/value";
import { ActionSchema, UpdateSchema, EntitySchema, HLCTimestampSchema } from "./types/index";
import { Action, Update, Entity } from "./types/index";

export { ActionSchema, UpdateSchema, EntitySchema, HLCTimestampSchema };

export function validateAction(action: unknown): action is Action {
  return Value.Check(ActionSchema, action);
}

export function validateUpdate(update: unknown): update is Update {
  return Value.Check(UpdateSchema, update);
}

export function validateEntity(entity: unknown): entity is Entity {
  return Value.Check(EntitySchema, entity);
}

export function validateActions(actions: unknown[]): actions is Action[] {
  return Array.isArray(actions) && actions.every((a) => validateAction(a));
}

export function validateCursor(cursor: unknown): cursor is number {
  return typeof cursor === "number" && cursor >= 0 && Number.isInteger(cursor);
}

export function validateHLCTimestamp(ts: unknown): ts is string {
  return Value.Check(HLCTimestampSchema, ts);
}
