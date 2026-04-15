export interface CursorStore {
  get(groupId: string): Promise<number | null>;
  set(groupId: string, cursor: number): Promise<void>;
}
