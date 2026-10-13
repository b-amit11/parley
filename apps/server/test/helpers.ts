import { randomUUID } from "node:crypto";
import { type ClientFrame, PROTOCOL, ServerFrame } from "@parley/shared";
import WebSocket from "ws";
import { type Limits, type RunningServer, startServer } from "../src/app.ts";
import { TEST_DB_URL, TEST_REDIS_URL } from "./env.ts";

export function startNode(nodeId: string, limits: Partial<Limits> = {}): Promise<RunningServer> {
  return startServer({
    limits,
    databaseUrl: TEST_DB_URL,
    redisUrl: TEST_REDIS_URL,
    port: 0,
    host: "127.0.0.1",
    nodeId,
    logLevel: "silent",
  });
}

export async function api<T = any>(
  base: string,
  path: string,
  opts: { method?: string; token?: string; body?: unknown } = {},
): Promise<{ status: number; body: T }> {
  const res = await fetch(base + path, {
    method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
    headers: {
      ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

export type TestUser = { id: string; username: string; token: string };

export async function signup(base: string, prefix = "user"): Promise<TestUser> {
  const username = `${prefix}_${randomUUID().slice(0, 8)}`;
  const r = await api(base, "/auth/signup", { body: { username, password: "correct horse" } });
  if (r.status !== 201) throw new Error(`signup failed: ${JSON.stringify(r.body)}`);
  return { ...r.body.user, token: r.body.token };
}

/** A workspace owned by `owner` with the other users invited. Returns its id and #general's id. */
export async function workspaceWith(base: string, owner: TestUser, ...members: TestUser[]) {
  const ws = await api(base, "/workspaces", { token: owner.token, body: { name: "Test team" } });
  for (const m of members) {
    await api(base, `/workspaces/${ws.body.workspace.id}/members`, {
      token: owner.token,
      body: { username: m.username },
    });
  }
  const channels = await api(base, `/workspaces/${ws.body.workspace.id}/channels`, {
    token: owner.token,
  });
  const general = channels.body.channels.find((c: { name: string }) => c.name === "general");
  return { workspaceId: ws.body.workspace.id as string, generalId: general.id as string };
}

type Frame = ServerFrame;

/** A WebSocket client that records every frame it receives, so tests can wait for specific ones. */
export class TestClient {
  readonly frames: Frame[] = [];
  private waiters: { pred: (f: Frame) => boolean; resolve: (f: Frame) => void }[] = [];

  private constructor(readonly ws: WebSocket) {
    ws.on("message", (data) => {
      const frame = ServerFrame.parse(JSON.parse(data.toString()));
      this.frames.push(frame);
      this.waiters = this.waiters.filter((w) => {
        if (!w.pred(frame)) return true;
        w.resolve(frame);
        return false;
      });
    });
  }

  static async connect(base: string, token: string): Promise<TestClient> {
    const ws = new WebSocket(`${base.replace(/^http/, "ws")}/ws`, [PROTOCOL, `token.${token}`]);
    const client = new TestClient(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once("error", reject);
      ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      ws.once("open", () => resolve());
    });
    await client.waitFor((f) => f.type === "ready");
    return client;
  }

  send(frame: ClientFrame | Record<string, unknown> | string): void {
    this.ws.send(typeof frame === "string" ? frame : JSON.stringify(frame));
  }

  waitFor<F extends Frame>(pred: (f: Frame) => f is F, timeoutMs?: number): Promise<F>;
  waitFor(pred: (f: Frame) => boolean, timeoutMs?: number): Promise<Frame>;
  waitFor(pred: (f: Frame) => boolean, timeoutMs = 5000): Promise<Frame> {
    const seen = this.frames.find(pred);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for frame")), timeoutMs);
      this.waiters.push({
        pred,
        resolve: (f) => {
          clearTimeout(timer);
          resolve(f);
        },
      });
    });
  }

  async subscribe(...channelIds: string[]): Promise<void> {
    const before = this.frames.length;
    this.send({ type: "subscribe", channelIds });
    await this.waitFor((f) => f.type === "subscribed" && this.frames.indexOf(f) >= before);
  }

  /** Sends a message and waits for its ack. */
  async post(channelId: string, body: string, clientMsgId: string = randomUUID()) {
    this.send({ type: "send", channelId, clientMsgId, body });
    const ack = await this.waitFor(
      (f): f is Extract<Frame, { type: "ack" }> => f.type === "ack" && f.clientMsgId === clientMsgId,
    );
    return ack.message;
  }

  /** Messages received live for a channel, deduplicated by seq, in seq order. */
  messages(channelId: string) {
    const bySeq = new Map<number, Extract<Frame, { type: "message" }>["message"]>();
    for (const f of this.frames) {
      if (f.type === "message" && f.message.channelId === channelId) bySeq.set(f.message.seq, f.message);
    }
    return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  }

  async waitForMessages(channelId: string, count: number, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (this.messages(channelId).length < count) {
      if (Date.now() > deadline) {
        throw new Error(`expected ${count} messages, got ${this.messages(channelId).length}`);
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    return this.messages(channelId);
  }

  close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolve) => {
      this.ws.once("close", () => resolve());
      this.ws.close();
    });
  }
}

export async function eventually(check: () => boolean | Promise<boolean>, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 20));
  }
}
