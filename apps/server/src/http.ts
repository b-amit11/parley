import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { hashPassword, verifyPassword } from "./auth.ts";
import type { Db } from "./db.ts";
import type { Fanout } from "./fanout.ts";
import * as store from "./store.ts";

const Username = z.string().regex(/^[a-z0-9_]{3,32}$/, "3-32 lowercase letters, digits or _");
const Credentials = z.object({ username: Username, password: z.string().min(8).max(200) });
const ChannelName = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/);
const Id = z.uuid();

declare module "fastify" {
  interface FastifyRequest {
    user: store.User;
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new HttpError(400, z.prettifyError(r.error));
  return r.data;
}

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  return h?.startsWith("Bearer ") ? h.slice(7) : null;
}

export function registerRoutes(app: FastifyInstance, db: Db, fanout: Fanout): void {
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    const { statusCode: status, message } = err as { statusCode?: number; message?: string };
    if (status && status < 500) return reply.status(status).send({ error: message });
    req.log.error({ err }, "request failed");
    return reply.status(500).send({ error: "Internal error" });
  });

  const authed = async (req: FastifyRequest, _reply: FastifyReply) => {
    const token = bearer(req);
    const user = token ? await store.userForToken(db, token) : null;
    if (!user) throw new HttpError(401, "Not signed in");
    req.user = user;
  };

  app.get("/healthz", async (_req, reply) => {
    const [pg, redis] = await Promise.allSettled([db.query("SELECT 1"), fanout.ping()]);
    const ok = pg.status === "fulfilled" && redis.status === "fulfilled" && redis.value;
    return reply.status(ok ? 200 : 503).send({
      postgres: pg.status === "fulfilled",
      redis: redis.status === "fulfilled" && redis.value,
    });
  });

  // ── auth ───────────────────────────────────────────────────────────────────

  app.post("/auth/signup", async (req, reply) => {
    const { username, password } = parse(Credentials, req.body);
    const user = await store.createUser(db, username, await hashPassword(password));
    if (!user) throw new HttpError(409, "Username is taken");
    return reply.status(201).send({ user, token: await store.createSession(db, user.id) });
  });

  app.post("/auth/login", async (req) => {
    const { username, password } = parse(Credentials, req.body);
    const found = await store.findUserByUsername(db, username);
    // Verify against a fixed hash when the user doesn't exist, so response timing doesn't reveal valid usernames.
    const ok = await verifyPassword(password, found?.passwordHash ?? DUMMY_HASH);
    if (!found || !ok) throw new HttpError(401, "Wrong username or password");
    return {
      user: { id: found.id, username: found.username },
      token: await store.createSession(db, found.id),
    };
  });

  app.post("/auth/logout", { preHandler: authed }, async (req, reply) => {
    await store.deleteSession(db, bearer(req)!);
    return reply.status(204).send();
  });

  app.get("/me", { preHandler: authed }, async (req) => ({ user: req.user }));

  // ── workspaces ─────────────────────────────────────────────────────────────

  app.get("/workspaces", { preHandler: authed }, async (req) => ({
    workspaces: await store.listWorkspaces(db, req.user.id),
  }));

  app.post("/workspaces", { preHandler: authed }, async (req, reply) => {
    const { name } = parse(z.object({ name: z.string().trim().min(1).max(80) }), req.body);
    return reply.status(201).send({ workspace: await store.createWorkspace(db, name, req.user.id) });
  });

  app.post("/workspaces/:id/members", { preHandler: authed }, async (req, reply) => {
    const id = parse(Id, (req.params as { id: string }).id);
    const { username } = parse(z.object({ username: Username }), req.body);
    if ((await store.workspaceRole(db, id, req.user.id)) !== "owner") {
      throw new HttpError(403, "Only the workspace owner can invite members");
    }
    const invitee = await store.findUserByUsername(db, username);
    if (!invitee) throw new HttpError(404, "No such user");
    const added = await store.addWorkspaceMember(db, id, invitee.id);
    return reply.status(added ? 201 : 200).send({ added });
  });

  app.get("/workspaces/:id/channels", { preHandler: authed }, async (req) => {
    const id = parse(Id, (req.params as { id: string }).id);
    if (!(await store.workspaceRole(db, id, req.user.id))) throw new HttpError(404, "No such workspace");
    return { channels: await store.listChannels(db, id, req.user.id) };
  });

  app.post("/workspaces/:id/channels", { preHandler: authed }, async (req, reply) => {
    const id = parse(Id, (req.params as { id: string }).id);
    const body = parse(
      z.object({ name: ChannelName, kind: z.enum(["public", "private"]).default("public") }),
      req.body,
    );
    const result = await store.createChannel(db, id, body.kind, body.name, req.user.id);
    if ("error" in result) {
      throw result.error === "forbidden"
        ? new HttpError(404, "No such workspace")
        : new HttpError(409, "A channel with that name already exists");
    }
    return reply.status(201).send({ channel: result.channel });
  });

  app.post("/workspaces/:id/dms", { preHandler: authed }, async (req) => {
    const id = parse(Id, (req.params as { id: string }).id);
    const { username } = parse(z.object({ username: Username }), req.body);
    const other = await store.findUserByUsername(db, username);
    const channel = other && (await store.getOrCreateDm(db, id, req.user.id, other.id));
    if (!channel) throw new HttpError(404, "No such workspace member");
    return { channel };
  });

  // ── channels ───────────────────────────────────────────────────────────────

  app.post("/channels/:id/join", { preHandler: authed }, async (req) => {
    const id = parse(Id, (req.params as { id: string }).id);
    if (!(await store.joinChannel(db, id, req.user.id))) throw new HttpError(404, "No such channel");
    return { joined: true };
  });

  app.post("/channels/:id/members", { preHandler: authed }, async (req) => {
    const id = parse(Id, (req.params as { id: string }).id);
    const { username } = parse(z.object({ username: Username }), req.body);
    const user = await store.findUserByUsername(db, username);
    if (!user || !(await store.addChannelMember(db, id, req.user.id, user.id))) {
      throw new HttpError(404, "No such channel or workspace member");
    }
    return { added: true };
  });

  app.get("/channels/:id/messages", { preHandler: authed }, async (req) => {
    const id = parse(Id, (req.params as { id: string }).id);
    const q = parse(
      z.object({
        before: z.coerce.number().int().positive().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      }),
      req.query,
    );
    if (!(await store.isMember(db, id, req.user.id))) throw new HttpError(404, "No such channel");
    return store.messagesBefore(db, id, q.before ?? null, q.limit);
  });
}

// A valid scrypt hash of a random password, used to keep login timing the same for unknown users.
const DUMMY_HASH = await hashPassword(crypto.randomUUID());
