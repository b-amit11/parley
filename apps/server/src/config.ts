import { hostname } from "node:os";
import type { Config } from "./app.ts";

export function configFromEnv(env = process.env): Config {
  return {
    databaseUrl: env.DATABASE_URL ?? "postgres://parley:parley@localhost:5433/parley",
    redisUrl: env.REDIS_URL ?? "redis://localhost:6380",
    port: Number(env.PORT ?? 3000),
    host: env.HOST ?? "0.0.0.0",
    nodeId: env.NODE_ID ?? hostname(),
    logLevel: env.LOG_LEVEL ?? "info",
    staticDir: env.STATIC_DIR || undefined,
  };
}
