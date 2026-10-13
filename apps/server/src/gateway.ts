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
import type { Fanout, Listener } from "./fanout.ts";
import { memberChannels, messagesAfter, sendMessage, type User, userForToken } from "./store.ts";

/** A slow client that has this many bytes waiting to be sent gets disconnected and must resync. */
export const MAX_BUFFERED_BYTES = 1 << 20;
/** Frames waiting to be processed for one socket before it counts as a flood. */
const MAX_PENDING_FRAMES = 100;
const MAX_FRAME_BYTES = 64 * 1024;

export type GatewayDeps = {
  db: Db;
  fanout: Fanout;
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

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    void authenticate(deps.db, req).then(
      (user) => {
        if (!user) return reject(socket, 401, "Unauthorized");
        wss.handleUpgrade(req, socket, head, (ws) => {
          const conn = new Connection(ws, user, deps);
          live.add(conn);
          ws.on("close", () => live.delete(conn));
          conn.start();
        });
      },
      (err) => {
        deps.log.error({ err }, "websocket auth failed");
        reject(socket, 503, "Service Unavailable");
      },
    );
  });

  return {
    connections: () => live.size,
    close: async () => {
      for (const conn of live) conn.close(1001, "server shutting down");
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

async function authenticate(db: Db, req: IncomingMessage): Promise<User | null> {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  if (path !== "/ws") return null;
  const offered = (req.headers["sec-websocket-protocol"] ?? "").split(",").map((p) => p.trim());
  const token = offered.find((p) => p.startsWith("token."))?.slice("token.".length);
  if (!offered.includes(PROTOCOL) || !token) return null;
  return userForToken(db, token);
}

function reject(socket: Duplex, status: number, text: string): void {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

class Connection {
  readonly id = randomUUID();
  private readonly subscriptions = new Map<string, Listener>();
  /** Frames are processed one at a time, so one sender's messages keep the order they were sent in. */
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;

  constructor(
    private readonly ws: WebSocket,
    private readonly user: User,
    private readonly deps: GatewayDeps,
  ) {}

  start(): void {
    this.ws.on("message", (data: RawData) => this.enqueue(data));
    this.ws.on("close", () => void this.cleanup());
    this.ws.on("error", (err) => this.deps.log.error({ err, conn: this.id }, "socket error"));
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
    this.pending++;
    this.queue = this.queue
      .then(() => this.handle(data))
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
    if (!parsed.success) return this.error("bad_request", z.prettifyError(parsed.error));
    const frame = parsed.data;

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
    }
  }

  private async subscribe(channelIds: string[]): Promise<void> {
    const wanted = [...new Set(channelIds)].filter((id) => !this.subscriptions.has(id));
    const allowed = wanted.length ? await memberChannels(this.deps.db, this.user.id, wanted) : new Set();
    // If the socket closed while we waited, cleanup has already run, and subscribing now would leak.
    if (this.ws.readyState !== WebSocket.OPEN) return;
    for (const id of wanted) {
      if (!allowed.has(id)) {
        this.error("forbidden", "Not a member of this channel", id);
        continue;
      }
      const listener: Listener = (message) => this.send({ type: "message", message });
      this.subscriptions.set(id, listener);
      await this.deps.fanout.subscribe(id, listener);
    }
    this.send({
      type: "subscribed",
      channelIds: channelIds.filter((id) => this.subscriptions.has(id)),
    });
  }

  private async unsubscribe(channelIds: string[]): Promise<void> {
    for (const id of channelIds) {
      const listener = this.subscriptions.get(id);
      if (!listener) continue;
      this.subscriptions.delete(id);
      await this.deps.fanout.unsubscribe(id, listener);
    }
    this.send({ type: "unsubscribed", channelIds });
  }

  private async sendMessage(frame: Extract<ClientFrame, { type: "send" }>): Promise<void> {
    const result = await sendMessage(this.deps.db, {
      channelId: frame.channelId,
      senderId: this.user.id,
      clientMsgId: frame.clientMsgId,
      body: frame.body,
    });
    if ("error" in result) {
      return result.error === "forbidden"
        ? this.error("forbidden", "Not a member of this channel", frame.clientMsgId)
        : this.error("bad_request", "clientMsgId was already used in another channel", frame.clientMsgId);
    }
    this.send({ type: "ack", clientMsgId: frame.clientMsgId, message: result.message });
    if (result.duplicate) return; // already fanned out the first time
    try {
      await this.deps.fanout.publish(result.message);
    } catch (err) {
      // The message is saved and acknowledged; other clients will pick it up through sync.
      this.deps.log.error({ err, channel: frame.channelId }, "fan-out publish failed");
    }
  }

  private async sync(channelId: string, afterSeq: number, limit: number): Promise<void> {
    const allowed = await memberChannels(this.deps.db, this.user.id, [channelId]);
    if (!allowed.has(channelId)) return this.error("forbidden", "Not a member of this channel", channelId);
    const { messages, hasMore } = await messagesAfter(this.deps.db, channelId, afterSeq, limit);
    this.send({ type: "sync_result", channelId, messages, hasMore });
  }

  private send(frame: ServerFrame): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    if (this.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      // Better to drop a slow client than to buffer without limit; it reconnects and syncs.
      this.ws.close(CloseCode.RESYNC, "client too slow, resync");
      return;
    }
    this.ws.send(JSON.stringify(frame));
  }

  private error(code: ErrorCode, message: string, ref?: string): void {
    this.send({ type: "error", code, message, ...(ref ? { ref } : {}) });
  }

  private async cleanup(): Promise<void> {
    const subs = [...this.subscriptions];
    this.subscriptions.clear();
    await Promise.allSettled(subs.map(([id, l]) => this.deps.fanout.unsubscribe(id, l)));
  }
}
