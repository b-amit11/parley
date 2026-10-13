import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Limits, RunningServer } from "../src/app.ts";
import { api, eventually, signup, startNode, TestClient, workspaceWith } from "./helpers.ts";

// Short timings so expiry and throttling can be observed within a test.
const LIMITS: Partial<Limits> = {
  sendLimit: { capacity: 5, refillPerSec: 1 },
  loginLimit: { capacity: 3, refillPerSec: 0.01 },
  typingThrottleMs: 500,
  heartbeatMs: 200,
  presenceTtlMs: 800,
  sweepMs: 100,
};

let node1: RunningServer;
let node2: RunningServer;
const clients: TestClient[] = [];

async function connect(node: RunningServer, token: string) {
  const c = await TestClient.connect(node.url, token);
  clients.push(c);
  return c;
}

const presenceOf = (c: TestClient, userId: string) =>
  c.frames
    .filter((f) => f.type === "presence" && f.userId === userId)
    .map((f) => f.type === "presence" && f.online);

beforeAll(async () => {
  [node1, node2] = await Promise.all([startNode("rt-1", LIMITS), startNode("rt-2", LIMITS)]);
});

afterAll(async () => {
  await Promise.all(clients.map((c) => c.close()));
  await Promise.all([node1.close(), node2.close()]);
});

describe("presence", () => {
  it("shows a snapshot, then live online/offline changes across servers, treating tabs as one user", async () => {
    const alice = await signup(node1.url, "alice");
    const bob = await signup(node1.url, "bob");
    const { workspaceId } = await workspaceWith(node1.url, bob, alice);

    const watcher = await connect(node2, bob.token);
    watcher.send({ type: "watch_presence", workspaceId });
    expect(await watcher.waitFor((f) => f.type === "presence_snapshot")).toEqual({
      type: "presence_snapshot",
      workspaceId,
      online: [bob.id],
    });

    const tab1 = await connect(node1, alice.token);
    await watcher.waitFor((f) => f.type === "presence" && f.userId === alice.id && f.online);
    const tab2 = await connect(node2, alice.token);
    await tab1.close();
    await new Promise((r) => setTimeout(r, 300));
    expect(presenceOf(watcher, alice.id)).toEqual([true]); // tab2 still open: no offline event

    await tab2.close();
    await watcher.waitFor((f) => f.type === "presence" && f.userId === alice.id && !f.online);
    expect(presenceOf(watcher, alice.id)).toEqual([true, false]);
  });

  it("marks a user offline when their server dies without cleaning up", async () => {
    const carol = await signup(node1.url, "carol");
    const bob = await signup(node1.url, "bob");
    const { workspaceId } = await workspaceWith(node1.url, bob, carol);
    const watcher = await connect(node2, bob.token);
    watcher.send({ type: "watch_presence", workspaceId });
    await watcher.waitFor((f) => f.type === "presence_snapshot");

    // A connection registered by a server that then crashes: nothing will refresh or remove it.
    expect(await node1.presence.touch(carol.id, `ghost-${randomUUID()}`)).toBe(true);
    expect(await node1.presence.onlineAmong([carol.id])).toEqual([carol.id]);

    // Nobody announced it (the "server" died first), but once it expires the sweep reports it offline.
    await watcher.waitFor((f) => f.type === "presence" && f.userId === carol.id && !f.online, 3000);
    expect(await node1.presence.onlineAmong([carol.id])).toEqual([]);
  });

  it("stays online while heartbeats keep refreshing the connection", async () => {
    const dana = await signup(node1.url, "dana");
    const d = await connect(node1, dana.token);
    await new Promise((r) => setTimeout(r, LIMITS.presenceTtlMs! * 2));
    expect(await node2.presence.onlineAmong([dana.id])).toEqual([dana.id]);
    await d.close();
    await eventually(async () => (await node2.presence.onlineAmong([dana.id])).length === 0);
  });

  it("only lets workspace members watch presence", async () => {
    const owner = await signup(node1.url, "owner");
    const eve = await signup(node1.url, "eve");
    const { workspaceId } = await workspaceWith(node1.url, owner);
    const e = await connect(node1, eve.token);
    e.send({ type: "watch_presence", workspaceId });
    expect(await e.waitFor((f) => f.type === "error")).toMatchObject({ code: "forbidden", ref: workspaceId });
  });
});

describe("typing indicators", () => {
  it("reaches others on another server, is throttled, and isn't echoed to the typist", async () => {
    const alice = await signup(node1.url, "alice");
    const bob = await signup(node1.url, "bob");
    const { generalId } = await workspaceWith(node1.url, alice, bob);
    const a = await connect(node1, alice.token);
    const b = await connect(node2, bob.token);
    await Promise.all([a.subscribe(generalId), b.subscribe(generalId)]);

    for (let i = 0; i < 5; i++) a.send({ type: "typing", channelId: generalId });
    await b.waitFor((f) => f.type === "typing" && f.userId === alice.id);
    a.send({ type: "ping" });
    await a.waitFor((f) => f.type === "pong");
    await new Promise((r) => setTimeout(r, 200));

    expect(b.frames.filter((f) => f.type === "typing")).toHaveLength(1);
    expect(a.frames.filter((f) => f.type === "typing")).toHaveLength(0);
  });

  it("requires a subscription to the channel", async () => {
    const alice = await signup(node1.url, "alice");
    const { generalId } = await workspaceWith(node1.url, alice);
    const a = await connect(node1, alice.token);
    a.send({ type: "typing", channelId: generalId });
    expect(await a.waitFor((f) => f.type === "error")).toMatchObject({ code: "forbidden" });
  });
});

describe("read receipts and unread counts", () => {
  it("broadcasts read positions, only moves forward, and drives unread counts", async () => {
    const alice = await signup(node1.url, "alice");
    const bob = await signup(node1.url, "bob");
    const { workspaceId, generalId } = await workspaceWith(node1.url, alice, bob);
    const a = await connect(node1, alice.token);
    const b = await connect(node2, bob.token);
    await Promise.all([a.subscribe(generalId), b.subscribe(generalId)]);
    for (const body of ["one", "two", "three"]) await a.post(generalId, body);

    const unread = async (user: { token: string }) =>
      (await api(node1.url, `/workspaces/${workspaceId}/channels`, { token: user.token })).body.channels[0]
        .unread;
    expect(await unread(bob)).toBe(3);
    expect(await unread(alice)).toBe(0); // sending marks your own messages as read

    b.send({ type: "read", channelId: generalId, seq: 2 });
    expect(await a.waitFor((f) => f.type === "read" && f.userId === bob.id)).toMatchObject({ seq: 2 });
    expect(await unread(bob)).toBe(1);

    b.send({ type: "read", channelId: generalId, seq: 1 }); // backwards: ignored
    b.send({ type: "read", channelId: generalId, seq: 99 }); // past the end: capped at 3
    await a.waitFor((f) => f.type === "read" && f.userId === bob.id && f.seq === 3);
    expect(
      a.frames.filter((f) => f.type === "read" && f.userId === bob.id).map((f) => f.type === "read" && f.seq),
    ).toEqual([2, 3]);
    expect(await unread(bob)).toBe(0);

    const reads = await api(node1.url, `/channels/${generalId}/reads`, { token: alice.token });
    expect(reads.body.reads).toEqual(
      expect.arrayContaining([
        { userId: alice.id, lastReadSeq: 3 },
        { userId: bob.id, lastReadSeq: 3 },
      ]),
    );
  });
});

describe("rate limiting", () => {
  it("limits a user's sends across all their connections and servers", async () => {
    const alice = await signup(node1.url, "alice");
    const { generalId } = await workspaceWith(node1.url, alice);
    const tab1 = await connect(node1, alice.token);
    const tab2 = await connect(node2, alice.token);

    const ids = Array.from({ length: 8 }, () => randomUUID());
    ids.forEach((clientMsgId, i) => {
      (i % 2 ? tab2 : tab1).send({ type: "send", channelId: generalId, clientMsgId, body: `m${i}` });
    });
    const outcomes = await Promise.all(
      ids.map((id, i) =>
        (i % 2 ? tab2 : tab1).waitFor(
          (f) => (f.type === "ack" && f.clientMsgId === id) || (f.type === "error" && f.ref === id),
        ),
      ),
    );
    const acked = outcomes.filter((f) => f.type === "ack");
    const limited = outcomes.filter((f) => f.type === "error");
    expect(acked).toHaveLength(5);
    expect(limited).toHaveLength(3);
    for (const f of limited) {
      expect(f).toMatchObject({ code: "rate_limited" });
      expect(f.type === "error" && f.retryAfterMs).toBeGreaterThan(0);
    }

    // Tokens come back over time.
    await new Promise((r) => setTimeout(r, 1100));
    expect(await tab1.post(generalId, "after waiting")).toMatchObject({ body: "after waiting" });
  });

  it("slows down password guessing for an account", async () => {
    const victim = await signup(node1.url, "victim");
    const attempt = () =>
      api(node2.url, "/auth/login", { body: { username: victim.username, password: "wrong guess" } });
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await attempt()).status);
    expect(statuses).toEqual([401, 401, 401, 429, 429]);
  });
});
