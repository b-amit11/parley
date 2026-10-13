import { configFromEnv } from "./config.ts";
import { createPool, migrate } from "./db.ts";

const db = createPool(configFromEnv().databaseUrl);
const applied = await migrate(db);
console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Database is up to date");
await db.end();
