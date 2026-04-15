import type { Action } from "@ebbjs/core";

export interface ActionLog {
  append(action: Action): Promise<void>;
  getAll(): Promise<readonly Action[]>;
  getForEntity(entityId: string): Promise<readonly Action[]>;
  clear(): Promise<void>;
}
