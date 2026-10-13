import pg from "pg";
import { createPool, migrate } from "../src/db.ts";
import { ADMIN_DB_URL, TEST_DB_NAME, TEST_DB_URL } from "./env.ts";

/** Creates a fresh test database for each run. Needs `npm run db:up`. */
export default async function setup(): Promise<void> {
  const admin = new pg.Client({ connectionString: ADMIN_DB_URL });
  try {
    await admin.connect();
  } catch (err) {
    throw new Error(`Postgres isn't reachable at ${ADMIN_DB_URL}. Run \`npm run db:up\` first.`, {
      cause: err,
    });
  }
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DB_NAME}`);
  await admin.end();
  const db = createPool(TEST_DB_URL);
  await migrate(db);
  await db.end();
}
