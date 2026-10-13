/**
 * The WebSocket gateway: authenticates the connection, then handles one socket per Connection.
 *
 * Authentication: browsers can't set headers on a WebSocket, so the session token travels as a
 * subprotocol (`Sec-WebSocket-Protocol: parley.v1, token.<token>`) rather than in the URL, where
 * proxies would log it.
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import {
  type BusFrame,
  ClientFrame,
  CloseCode,
  type ErrorCode,
  MAX_SYNC_LIMIT,
  PROTOCOL,
  type ServerFrame,
} from "@parley/shared";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import type { Db } from "./db.ts";
import { channelTopic, type Fanout, type Listener, workspaceTopic } from "./fanout.ts";
import { metrics } from "./metrics.ts";
import type { Presence } from "./presence.ts";
import type { Bucket, RateLimiter } from "./ratelimit.ts";
import * as store from "./store.ts";

/** A slow client that has this many bytes waiting to be sent gets disconnected and must resync. */
export const MAX_BUFFERED_BYTES = 1 << 20;
/** Frames waiting to be processed for one socket before it counts as a flood. */
const MAX_PENDING_FRAMES = 100;
const MAX_FRAME_BYTES = 64 * 1024;

export type GatewayOptions = {
  sendLimit: Bucket;
  typingThrottleMs: number;
  heartbeatMs: number;
  sweepMs: number;
};

export type GatewayDeps = {
  db: Db;
  fanout: Fanout;
  presence: Presence;
  limiter: RateLimiter;
  options: GatewayOptions;
  log: { info(obj: object, msg?: string): void; error(obj: object, msg?: string): void };
};

export type Gateway = { connections: () => number; close: () => Promise<void> };

export function attachGateway(server: Server, deps: GatewayDeps): Gateway {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES,
    handleProtocols: (protocols) => (protocols.has(PROTOCOL) ? PROTOCOL : false),
  });
  const live = new Set<Connection>();
  const presence = new PresenceAnnouncer(deps);

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    void authenticate(deps.db, req).then(
      (user) => {
        if (!user) return reject(socket, 401, "Unauthorized");
        wss.handleUpgrade(req, socket, head, (ws) => {
          const conn = new Connection(ws, user, deps, presence);
          live.add(conn);
          metrics.connections.inc();
          ws.on("close", () => {
            live.delete(conn);
            metrics.connections.dec();
          });
          conn.start();
        });
      },
      (err) => {
        deps.log.error({ err }, "websocket auth failed");
        reject(socket, 503, "Service Unavailable");
      },
    );
  });

  // Heartbeat: keep this server's connections alive in the presence store. If this server dies,
  // they expire and another server's sweep announces those users as offline.
  const heartbeat = setInterval(() => {
    const conns = [...live].map((c) => ({ userId: c.userId, connId: c.id }));
    deps.presence.touchMany(conns).then(
      (cameOnline) => {
        for (const userId of new Set(cameOnline)) presence.announce(userId, true);
      },
      (err) => deps.log.error({ err }, "presence heartbeat failed"),
    );
  }, deps.options.heartbeatMs);
  const sweep = setInterval(() => {
    deps.presence.sweep().then(
      (gone) => {
        metrics.presenceSwept.inc(gone.length);
        for (const userId of gone) presence.announce(userId, false);
      },
      (err) => deps.log.error({ err }, "presence sweep failed"),
    );
  }, deps.options.sweepMs);

  return {
    connections: () => live.size,
    close: async () => {
      clearInterval(heartbeat);
      clearInterval(sweep);
      const closing = [...live].map((conn) => conn.closed);
      for (const conn of live) conn.close(1001, "server shutting down");
      await Promise.allSettled(closing);
      await presence.drain();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

async function authenticate(db: Db, req: IncomingMessage): Promise<store.User | null> {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  if (path !== "/ws") return null;
  const offered = (req.headers["sec-websocket-protocol"] ?? "").split(",").map((p) => p.trim());
  const token = offered.find((p) => p.startsWith("token."))?.slice("token.".length);
  if (!offered.includes(PROTOCOL) || !token) return null;
  return store.userForToken(db, token);
}

function reject(socket: Duplex, status: number, text: string): void {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/** Publishes online/offline changes to every workspace the user belongs to. */
class PresenceAnnouncer {
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly deps: GatewayDeps) {}

  /** Waits for announcements still in flight (used during shutdown). */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }

  announce(userId: string, online: boolean): void {
    const task = (async () => {
      const workspaces = await store.workspaceIdsOf(this.deps.db, userId);
      await Promise.all(
        workspaces.map((workspaceId) =>
          this.deps.fanout.publish(workspaceTopic(workspaceId), {
            type: "presence",
            workspaceId,
            userId,
            online,
          }),
        ),
      );
    })()
      .catch((err) => this.deps.log.error({ err, userId }, "presence announce failed"))
      .finally(() => this.pending.delete(task));
    this.pending.add(task);
  }
}

class Connection {
  readonly id = randomUUID();
  readonly closed: Promise<void>;
  /** Topic → listener, for channels (`chan:`) and workspaces being watched for presence (`wsp:`). */
  private readonly topics = new Map<string, Listener>();
  private readonly lastTyping = new Map<string, number>();
  /** Frames are processed one at a time, so one sender's messages keep the order they were sent in. */
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;
  private markClosed!: () => void;

  constructor(
    private readonly ws: WebSocket,
    private readonly user: store.User,
    private readonly deps: GatewayDeps,
    private readonly presence: PresenceAnnouncer,
  ) {
    this.closed = new Promise((resolve) => {
      this.markClosed = resolve;
    });
  }

  get userId(): string {
    return this.user.id;
  }

  start(): void {
    this.ws.on("message", (data: RawData) => this.enqueue(data));
    this.ws.on("close", () => void this.cleanup().finally(this.markClosed));
    this.ws.on("error", (err) => this.deps.log.error({ err, conn: this.id }, "socket error"));
    // Registering presence goes through the frame queue too, so it finishes before anything
    // this socket asks for, and before cleanup can run.
    this.run(async () => {
      if (await this.deps.presence.touch(this.user.id, this.id)) this.presence.announce(this.user.id, true);
    });
    this.send({ type: "ready", userId: this.user.id, connectionId: this.id });
  }

  close(code: number, reason: string): void {
    this.ws.close(code, reason);
  }

  private enqueue(data: RawData): void {
    if (this.pending >= MAX_PENDING_FRAMES) {
      this.error("rate_limited", "Too many frames in flight");
      return;
    }
    this.run(() => this.handle(data));
  }

  private run(task: () => Promise<void>): void {
    this.pending++;
    this.queue = this.queue
      .then(task)
      .catch((err) => {
        this.deps.log.error({ err, conn: this.id }, "frame handler failed");
        this.error("internal", "Internal error");
      })
      .finally(() => {
        this.pending--;
      });
  }

  private async handle(data: RawData): Promise<void> {
    let json: unknown;
    try {
      json = JSON.parse(data.toString());
    } catch {
      return this.error("bad_request", "Frame is not valid JSON");
    }
    const parsed = ClientFrame.safeParse(json);
    if (!parsed.success) {
      metrics.frames.inc({ type: "invalid" });
      return this.error("bad_request", z.prettifyError(parsed.error));
    }
    const frame = parsed.data;
    metrics.frames.inc({ type: frame.type });

    switch (frame.type) {
      case "ping":
        return this.send({ type: "pong" });
      case "subscribe":
        return this.subscribe(frame.channelIds);
      case "unsubscribe":
        return this.unsubscribe(frame.channelIds);
      case "send":
        return this.sendMessage(frame);
      case "sync":
        return this.sync(frame.channelId, frame.afterSeq, frame.limit ?? MAX_SYNC_LIMIT);
      case "typing":
        return this.typing(frame.channelId);
      case "read":
        return this.read(frame.channelId, frame.seq);
      case "watch_presence":
        return this.watchPresence(frame.workspaceId);
    }
  }

  private isSubscribed(channelId: string): boolean {
    return this.topics.has(channelTopic(channelId));
  }

  private async listen(topic: string): Promise<void> {
    if (this.topics.has(topic)) return;
    const listener: Listener = (frame) => this.forward(frame);
    this.topics.set(topic, listener);
    await this.deps.fanout.subscribe(topic, listener);
  }

  private forward(frame: BusFrame): void {
    // People don't need to see their own typing indicator.
    if (frame.type === "typing" && frame.userId === this.user.id) return;
    this.send(frame);
  }

  private async subscribe(channelIds: string[]): Promise<void> {
    const wanted = [...new Set(channelIds)].filter((id) => !this.isSubscribed(id));
    const allowed = wanted.length
      ? await store.memberChannels(this.deps.db, this.user.id, wanted)
      : new Set();
    // If the socket closed while we waited, cleanup has already run, and subscribing now would leak.
    if (this.ws.readyState !== WebSocket.OPEN) return;
    for (const id of wanted) {
      if (allowed.has(id)) await this.listen(channelTopic(id));
      else this.error("forbidden", "Not a member of this channel", id);
    }
    this.send({ type: "subscribed", channelIds: channelIds.filter((id) => this.isSubscribed(id)) });
  }

  private async unsubscribe(channelIds: string[]): Promise<void> {
    for (const id of channelIds) {
      const topic = channelTopic(id);
      const listener = this.topics.get(topic);
      if (!listener) continue;
      this.topics.delete(topic);
      await this.deps.fanout.unsubscribe(topic, listener);
    }
    this.send({ type: "unsubscribed", channelIds });
  }

  private async sendMessage(frame: Extract<ClientFrame, { type: "send" }>): Promise<void> {
    const timer = metrics.sendSeconds.startTimer();
    try {
      await this.storeAndAck(frame);
    } finally {
      timer();
    }
  }

  private async storeAndAck(frame: Extract<ClientFrame, { type: "send" }>): Promise<void> {
    const limit = await this.deps.limiter.take(`send:${this.user.id}`, this.deps.options.sendLimit);
    if (!limit.allowed) {
      metrics.rateLimited.inc({ action: "send" });
      return this.error("rate_limited", "Sending too fast", frame.clientMsgId, limit.retryAfterMs);
    }
    const result = await store.sendMessage(this.deps.db, {
      channelId: frame.channelId,
      senderId: this.user.id,
      clientMsgId: frame.clientMsgId,
      body: frame.body,
    });
    if ("error" in result) {
      metrics.messages.inc({ outcome: "rejected" });
      return result.error === "forbidden"
        ? this.error("forbidden", "Not a member of this channel", frame.clientMsgId)
        : this.error("bad_request", "clientMsgId was already used in another channel", frame.clientMsgId);
    }
    this.send({ type: "ack", clientMsgId: frame.clientMsgId, message: result.message });
    metrics.messages.inc({ outcome: result.duplicate ? "duplicate" : "new" });
    if (result.duplicate) return; // already fanned out the first time
    try {
      await this.deps.fanout.publish(channelTopic(frame.channelId), {
        type: "message",
        message: result.message,
      });
    } catch (err) {
      // The message is saved and acknowledged; other clients will pick it up through sync.
      metrics.publishFailures.inc();
      this.deps.log.error({ err, channel: frame.channelId }, "fan-out publish failed");
    }
  }

  private async sync(channelId: string, afterSeq: number, limit: number): Promise<void> {
    const allowed = await store.memberChannels(this.deps.db, this.user.id, [channelId]);
    if (!allowed.has(channelId)) return this.error("forbidden", "Not a member of this channel", channelId);
    const { messages, hasMore } = await store.messagesAfter(this.deps.db, channelId, afterSeq, limit);
    this.send({ type: "sync_result", channelId, messages, hasMore });
  }

  /** Typing indicators are throttled on this server and never stored (DESIGN.md §5). */
  private async typing(channelId: string): Promise<void> {
    if (!this.isSubscribed(channelId))
      return this.error("forbidden", "Subscribe to the channel first", channelId);
    const now = Date.now();
    if (now - (this.lastTyping.get(channelId) ?? 0) < this.deps.options.typingThrottleMs) return;
    this.lastTyping.set(channelId, now);
    await this.deps.fanout.publish(channelTopic(channelId), {
      type: "typing",
      channelId,
      userId: this.user.id,
    });
  }

  private async read(channelId: string, seq: number): Promise<void> {
    if (!this.isSubscribed(channelId))
      return this.error("forbidden", "Subscribe to the channel first", channelId);
    const advanced = await store.markRead(this.deps.db, channelId, this.user.id, seq);
    if (advanced === null) return; // already read at least this far
    await this.deps.fanout.publish(channelTopic(channelId), {
      type: "read",
      channelId,
      userId: this.user.id,
      seq: advanced,
    });
  }

  private async watchPresence(workspaceId: string): Promise<void> {
    if (!(await store.workspaceRole(this.deps.db, workspaceId, this.user.id))) {
      return this.error("forbidden", "Not a member of this workspace", workspaceId);
    }
    if (this.ws.readyState !== WebSocket.OPEN) return;
    // Subscribe before taking the snapshot, so no change between the two is missed.
    await this.listen(workspaceTopic(workspaceId));
    const members = await store.workspaceMemberIds(this.deps.db, workspaceId);
    const online = await this.deps.presence.onlineAmong(members);
    this.send({ type: "presence_snapshot", workspaceId, online });
  }

  private send(frame: ServerFrame): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    if (this.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      // Better to drop a slow client than to buffer without limit; it reconnects and syncs.
      metrics.slowClients.inc();
      this.ws.close(CloseCode.RESYNC, "client too slow, resync");
      return;
    }
    this.ws.send(JSON.stringify(frame));
  }

  private error(code: ErrorCode, message: string, ref?: string, retryAfterMs?: number): void {
    this.send({
      type: "error",
      code,
      message,
      ...(ref ? { ref } : {}),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }

  private async cleanup(): Promise<void> {
    // Wait for in-flight frames (including the initial presence registration) to finish first.
    await this.queue;
    const topics = [...this.topics];
    this.topics.clear();
    await Promise.allSettled(topics.map(([topic, l]) => this.deps.fanout.unsubscribe(topic, l)));
    try {
      if (await this.deps.presence.drop(this.user.id, this.id)) this.presence.announce(this.user.id, false);
    } catch (err) {
      // If Redis is unreachable the entry expires on its own, and a sweep announces it.
      this.deps.log.error({ err, conn: this.id }, "presence drop failed");
    }
  }
}
