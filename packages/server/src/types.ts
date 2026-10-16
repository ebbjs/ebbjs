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

// Seed types live in the browser-safe `@ebbjs/core/seed` module; the
// server re-exports them so its public surface is unchanged.
export type {
  Action,
  GroupSeed,
  GroupMemberSeed,
  EntitySeed,
  RelationshipSeed,
  EntityGroupSeed,
  SeedData,
  SeedRejection,
} from "@ebbjs/core/seed";
