import { customAlphabet } from "nanoid";

export const ID_PREFIX_ACTION = "a";
export const ID_PREFIX_UPDATE = "u";

const nanoid = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 16);

export function generateId(prefix: string): string {
  const id = nanoid();
  return `${prefix}_${id}`;
}
