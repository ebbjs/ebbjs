import type { Entity } from "@ebbjs/core";

export interface EntityStore {
  get(id: string): Promise<Entity | null>;
  set(entity: Entity): Promise<void>;
  query(type: string): Promise<readonly Entity[]>;
  reset(): Promise<void>;
}
