import Fastify, { type FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import { createPool, type Db } from "./db.ts";
import { Fanout } from "./fanout.ts";
import { attachGateway, type Gateway, type GatewayOptions } from "./gateway.ts";
import { registerRoutes } from "./http.ts";
import { Presence } from "./presence.ts";
import { type Bucket, RateLimiter } from "./ratelimit.ts";

export type Limits = GatewayOptions & {
  /** Failed logins per username, against password guessing. */
  loginLimit: Bucket;
  /** How long a connection counts as online without a heartbeat. */
  presenceTtlMs: number;
};

export const DEFAULT_LIMITS: Limits = {
  sendLimit: { capacity: 20, refillPerSec: 5 },
  loginLimit: { capacity: 10, refillPerSec: 1 / 30 },
  typingThrottleMs: 2000,
  heartbeatMs: 20_000,
  presenceTtlMs: 60_000,
  sweepMs: 10_000,
};

export type Config = {
  databaseUrl: string;
  redisUrl: string;
  port: number;
  host: string;
  nodeId: string;
  logLevel: string;
  limits?: Partial<Limits>;
};

export type RunningServer = {
  app: FastifyInstance;
  db: Db;
  redis: Redis;
  fanout: Fanout;
  presence: Presence;
  gateway: Gateway;
  url: string;
  close: () => Promise<void>;
};

export async function startServer(config: Config): Promise<RunningServer> {
  const limits = { ...DEFAULT_LIMITS, ...config.limits };
  const app = Fastify({
    logger: { level: config.logLevel, base: { node: config.nodeId } },
    bodyLimit: 64 * 1024,
  });
  const onRedisError = (err: unknown) => app.log.error({ err }, "redis error");
  const db = createPool(config.databaseUrl);
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 2 });
  redis.on("error", onRedisError);
  const fanout = new Fanout(redis, onRedisError);
  const presence = new Presence(redis, limits.presenceTtlMs);
  const limiter = new RateLimiter(redis, onRedisError);

  registerRoutes(app, { db, redis, limiter, loginLimit: limits.loginLimit });
  const gateway = attachGateway(app.server, {
    db,
    fanout,
    presence,
    limiter,
    options: limits,
    log: app.log,
  });

  const address = await app.listen({ port: config.port, host: config.host });
  let closed = false;
  return {
    app,
    db,
    redis,
    fanout,
    presence,
    gateway,
    url: address,
    async close() {
      if (closed) return;
      closed = true;
      await gateway.close();
      await app.close();
      await fanout.close();
      await redis.quit().catch(() => {});
      await db.end();
    },
  };
}
