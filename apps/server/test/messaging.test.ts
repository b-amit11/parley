import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunningServer } from "../src/app.ts";
import { sendMessage } from "../src/store.ts";
import { api, eventually, signup, startNode, TestClient, workspaceWith } from "./helpers.ts";

let node1: RunningServer;
let node2: RunningServer;
const clients: TestClient[] = [];

async function connect(node: RunningServer, token: string) {
  const c = await TestClient.connect(node.url, token);
  clients.push(c);
  return c;
}

beforeAll(async () => {
  // These tests are about ordering and delivery, so the send limit is raised out of the way.
  const limits = { sendLimit: { capacity: 10_000, refillPerSec: 10_000 } };
  [node1, node2] = await Promise.all([startNode("node-1", limits), startNode("node-2", limits)]);
});

afterAll(async () => {
  await Promise.all(clients.map((c) => c.close()));
  await Promise.all([node1.close(), node2.close()]);
});

describe("delivery across servers", () => {
  it("delivers a message to a member connected to a different server", async () => {
    const alice = await signup(node1.url, "alice");
    const bob = await signup(node1.url, "bob");
    const { generalId } = await workspaceWith(node1.url, alice, bob);

    const a = await connect(node1, alice.token);
    const b = await connect(node2, bob.token);
    await Promise.all([a.subscribe(generalId), b.subscribe(generalId)]);

    const sent = await a.post(generalId, "hello from node 1");
    expect(sent).toMatchObject({ seq: 1, senderId: alice.id, body: "hello from node 1" });

    const [received] = await b.waitForMessages(generalId, 1);
    expect(received).toEqual(sent);
  });

  it("gives every client the same order, even with concurrent senders on different servers", async () => {
    const users = await Promise.all([1, 2, 3].map((i) => signup(node1.url, `u${i}`)));
    const [owner, ...rest] = users as [(typeof users)[0], ...typeof users];
    const { generalId } = await workspaceWith(node1.url, owner, ...rest);
    const conns = await Promise.all(users.map((u, i) => connect(i % 2 ? node2 : node1, u.token)));
    await Promise.all(conns.map((c) => c.subscribe(generalId)));

    const PER_SENDER = 40;
    const sent = conns.map(() => [] as string[]);
    conns.forEach((c, i) => {
      for (let n = 0; n < PER_SENDER; n++) {
        const clientMsgId = randomUUID();
        sent[i]!.push(clientMsgId);
        c.send({ type: "send", channelId: generalId, clientMsgId, body: `sender ${i} #${n}` });
      }
    });

    const total = PER_SENDER * conns.length;
    const views = await Promise.all(conns.map((c) => c.waitForMessages(generalId, total)));

    // Sequence numbers are contiguous: 1..total with no gaps.
    expect(views[0]!.map((m) => m.seq)).toEqual(Array.from({ length: total }, (_, i) => i + 1));
    // Every client sees the identical order.
    for (const view of views) expect(view.map((m) => m.id)).toEqual(views[0]!.map((m) => m.id));
    // Each sender's messages appear in the order they were sent.
    users.forEach((u, i) => {
      const bodies = views[0]!.filter((m) => m.senderId === u.id).map((m) => m.body);
      expect(bodies).toEqual(Array.from({ length: PER_SENDER }, (_, n) => `sender ${i} #${n}`));
    });
  });
});

describe("idempotent sends", () => {
  it("stores a retried message once, even when retries race on different servers", async () => {
    const alice = await signup(node1.url, "alice");
    const { generalId } = await workspaceWith(node1.url, alice);
    const tab1 = await connect(node1, alice.token);
    const tab2 = await connect(node2, alice.token);
    const clientMsgId = randomUUID();

    const acks = await Promise.all([
      tab1.post(generalId, "only once", clientMsgId),
      tab2.post(generalId, "only once", clientMsgId),
      tab1.post(generalId, "only once", clientMsgId),
    ]);
    expect(new Set(acks.map((m) => m.id)).size).toBe(1);

    const history = await api(node1.url, `/channels/${generalId}/messages`, { token: alice.token });
    expect(history.body.messages).toHaveLength(1);
  });

  it("keeps seq gapless when duplicate sends race inside the database", async () => {
    const alice = await signup(node1.url, "alice");
    const { generalId } = await workspaceWith(node1.url, alice);
    const clientMsgId = randomUUID();
    const input = { channelId: generalId, senderId: alice.id, clientMsgId, body: "race" };

    const results = await Promise.all(Array.from({ length: 10 }, () => sendMessage(node1.db, input)));
    const ids = results.map((r) => ("message" in r ? r.message.id : r.error));
    expect(new Set(ids).size).toBe(1);

    const next = await sendMessage(node1.db, { ...input, clientMsgId: randomUUID(), body: "next" });
    expect("message" in next && next.message.seq).toBe(2);
  });

  it("refuses to reuse a clientMsgId in a different channel", async () => {
    const alice = await signup(node1.url, "alice");
    const { workspaceId, generalId } = await workspaceWith(node1.url, alice);
    const other = await api(node1.url, `/workspaces/${workspaceId}/channels`, {
      token: alice.token,
      body: { name: "random" },
    });
    const a = await connect(node1, alice.token);
    const clientMsgId = randomUUID();
    await a.post(generalId, "first", clientMsgId);
    a.send({ type: "send", channelId: other.body.channel.id, clientMsgId, body: "second" });
    const err = await a.waitFor((f) => f.type === "error" && f.ref === clientMsgId);
    expect(err).toMatchObject({ code: "bad_request" });
  });
});

describe("catching up", () => {
  it("returns everything after the last seq a client saw, once it reconnects", async () => {
    const alice = await signup(node1.url, "alice");
    const bob = await signup(node1.url, "bob");
    const { generalId } = await workspaceWith(node1.url, alice, bob);
    const a = await connect(node1, alice.token);
    let b = await connect(node2, bob.token);
    await Promise.all([a.subscribe(generalId), b.subscribe(generalId)]);

    await a.post(generalId, "before");
    const [seen] = await b.waitForMessages(generalId, 1);
    await b.close();

    for (const body of ["missed 1", "missed 2", "missed 3"]) await a.post(generalId, body);

    b = await connect(node1, bob.token); // reconnects to a different server
    b.send({ type: "sync", channelId: generalId, afterSeq: seen!.seq });
    const result = await b.waitFor((f) => f.type === "sync_result");
    expect(result).toMatchObject({ channelId: generalId, hasMore: false });
    if (result.type !== "sync_result") throw new Error("unreachable");
    expect(result.messages.map((m) => [m.seq, m.body])).toEqual([
      [2, "missed 1"],
      [3, "missed 2"],
      [4, "missed 3"],
    ]);
  });

  it("pages through a long backlog with hasMore", async () => {
    const alice = await signup(node1.url, "alice");
    const { generalId } = await workspaceWith(node1.url, alice);
    const a = await connect(node1, alice.token);
    for (let i = 0; i < 5; i++) await a.post(generalId, `m${i}`);
    a.send({ type: "sync", channelId: generalId, afterSeq: 0, limit: 3 });
    const page = await a.waitFor((f) => f.type === "sync_result");
    expect(page).toMatchObject({ hasMore: true });
    if (page.type === "sync_result") expect(page.messages.map((m) => m.seq)).toEqual([1, 2, 3]);
  });
});

describe("authorization and validation", () => {
  it("doesn't let non-members read or write a channel", async () => {
    const alice = await signup(node1.url, "alice");
    const eve = await signup(node1.url, "eve");
    const { generalId } = await workspaceWith(node1.url, alice);
    const e = await connect(node2, eve.token);

    e.send({ type: "subscribe", channelIds: [generalId] });
    expect(await e.waitFor((f) => f.type === "subscribed")).toEqual({ type: "subscribed", channelIds: [] });
    expect(await e.waitFor((f) => f.type === "error" && f.ref === generalId)).toMatchObject({
      code: "forbidden",
    });

    const clientMsgId = randomUUID();
    e.send({ type: "send", channelId: generalId, clientMsgId, body: "let me in" });
    expect(await e.waitFor((f) => f.type === "error" && f.ref === clientMsgId)).toMatchObject({
      code: "forbidden",
    });

    const history = await api(node1.url, `/channels/${generalId}/messages`, { token: eve.token });
    expect(history.status).toBe(404);
  });

  it("answers malformed frames with an error and keeps the socket open", async () => {
    const alice = await signup(node1.url, "alice");
    const a = await connect(node1, alice.token);
    a.send("not json");
    a.send({ type: "send", channelId: "nope", clientMsgId: randomUUID(), body: "" });
    a.send({ type: "teleport" });
    a.send({ type: "ping" });
    await a.waitFor((f) => f.type === "pong");
    const errors = a.frames.filter((f) => f.type === "error");
    expect(errors.map((f) => f.type === "error" && f.code)).toEqual([
      "bad_request",
      "bad_request",
      "bad_request",
    ]);
  });

  it("refuses WebSocket connections without a valid session", async () => {
    await expect(TestClient.connect(node1.url, "not-a-real-token")).rejects.toThrow("HTTP 401");
  });
});

describe("fan-out bookkeeping", () => {
  it("unsubscribes the server from Redis when its last local listener leaves", async () => {
    const alice = await signup(node1.url, "alice");
    const { generalId } = await workspaceWith(node1.url, alice);
    const before = node2.fanout.topicCount;
    const tab1 = await connect(node2, alice.token);
    const tab2 = await connect(node2, alice.token);
    await Promise.all([tab1.subscribe(generalId), tab2.subscribe(generalId)]);
    expect(node2.fanout.topicCount).toBe(before + 1);

    await tab1.close();
    expect(node2.fanout.topicCount).toBe(before + 1);
    await tab2.close();
    await eventually(() => node2.fanout.topicCount === before);
  });
});
