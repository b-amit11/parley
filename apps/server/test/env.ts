const host = process.env.TEST_PG_HOST ?? "localhost:5433";
export const ADMIN_DB_URL = `postgres://parley:parley@${host}/parley`;
export const TEST_DB_NAME = "parley_test";
export const TEST_DB_URL = `postgres://parley:parley@${host}/${TEST_DB_NAME}`;
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6380";
