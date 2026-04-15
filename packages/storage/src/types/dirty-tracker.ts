export interface DirtyTracker {
  mark(entityId: string, entityType: string): Promise<void>;
  isDirty(entityId: string): Promise<boolean>;
  getDirtyForType(entityType: string): Promise<readonly string[]>;
  clear(entityId: string): Promise<void>;
  clearAll(): Promise<void>;
}
