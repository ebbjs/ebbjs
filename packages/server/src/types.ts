import { Action } from "@ebbjs/core";

export interface ServerOptions {
  dataDir: string;
  port?: number;
  env?: Record<string, string>;
}

export interface RunningServer {
  pid: number;
  port: number;
  url: string;
  dataDir: string;
  kill(): Promise<void>;
}

export interface GroupSeed {
  id: string;
  name: string;
}

export interface GroupMemberSeed {
  id: string;
  actorId: string;
  groupId: string;
  permissions: string[];
}

export interface EntitySeed {
  id: string;
  type: string;
  patches: Array<{
    fields: Record<string, { value: unknown; hlc: string; update_id: string }>;
  }>;
}

export interface RelationshipSeed {
  id: string;
  sourceId: string;
  targetId: string;
  type: string;
  field: string;
}

/** One entity↔Group membership row, submitted as an `entityGroup` put. */
export interface EntityGroupSeed {
  id: string;
  entityId: string;
  groupId: string;
}

export interface SeedData {
  groups: GroupSeed[];
  groupMembers: GroupMemberSeed[];
  entities: EntitySeed[];
  relationships?: RelationshipSeed[];
  entityGroups?: EntityGroupSeed[];
  baseHlc?: number;
}

export type { Action };
