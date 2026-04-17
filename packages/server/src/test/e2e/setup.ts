import { startServer } from "@ebbjs/server";
import type { RunningServer } from "@ebbjs/server";

let server: RunningServer;

beforeAll(async () => {
  server = await startServer({
    dataDir: process.env.EBB_SERVER_DATA_DIR ?? "/tmp/ebb-test-data",
    port: 4000,
  });
}, 30000);

afterAll(async () => {
  await server.kill();
});

export { server };
