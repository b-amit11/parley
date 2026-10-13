import { startServer } from "./app.ts";
import { configFromEnv } from "./config.ts";
import { createPool, migrate } from "./db.ts";

const config = configFromEnv();

if (process.env.MIGRATE_ON_START !== "false") {
  const db = createPool(config.databaseUrl);
  await migrate(db);
  await db.end();
}

const server = await startServer(config);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.app.log.info({ signal }, "shutting down");
    // Close sockets first so clients reconnect to another server, then drain HTTP requests.
    void server.close().then(() => process.exit(0));
  });
}
