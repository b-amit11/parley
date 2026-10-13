import Fastify, { type FastifyInstance } from "fastify";
import { createPool, type Db } from "./db.ts";
import { Fanout } from "./fanout.ts";
import { attachGateway, type Gateway } from "./gateway.ts";
import { registerRoutes } from "./http.ts";

export type Config = {
  databaseUrl: string;
  redisUrl: string;
  port: number;
  host: string;
  nodeId: string;
  logLevel: string;
};

export type RunningServer = {
  app: FastifyInstance;
  db: Db;
  fanout: Fanout;
  gateway: Gateway;
  url: string;
  close: () => Promise<void>;
};

export async function startServer(config: Config): Promise<RunningServer> {
  const app = Fastify({
    logger: { level: config.logLevel, base: { node: config.nodeId } },
    bodyLimit: 64 * 1024,
  });
  const db = createPool(config.databaseUrl);
  const fanout = new Fanout(config.redisUrl, (err) => app.log.error({ err }, "redis error"));
  registerRoutes(app, db, fanout);
  const gateway = attachGateway(app.server, { db, fanout, log: app.log });

  const address = await app.listen({ port: config.port, host: config.host });
  let closed = false;
  return {
    app,
    db,
    fanout,
    gateway,
    url: address,
    async close() {
      if (closed) return;
      closed = true;
      await gateway.close();
      await app.close();
      await fanout.close();
      await db.end();
    },
  };
}
