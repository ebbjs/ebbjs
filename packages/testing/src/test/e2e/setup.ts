import { startServer } from "@ebbjs/testing";
import type { RunningServer } from "@ebbjs/testing";

let server: RunningServer;

beforeAll(async () => {
  server = await startServer({
    dataDir: process.env.EBB_SERVER_DATA_DIR ?? "/tmp/ebb-test-data",
    port: 4000,
  });
}, 60000);

afterAll(async () => {
  await server.kill();
});

export { server };
