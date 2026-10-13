/**
 * The real ChatClient (the same code the browser runs) against two real servers.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunningServer } from "../../server/src/app.ts";
import { eventually, signup, startNode, type TestUser, workspaceWith } from "../../server/test/helpers.ts";
import { Api } from "../src/lib/api.ts";
import { ChatClient } from "../src/lib/client.ts";

let node1: RunningServer;
let node2: RunningServer;
const clients: ChatClient[] = [];

beforeAll(async () => {
  [node1, node2] = await Promise.all([startNode("web-1"), startNode("web-2")]);
});
afterAll(async () => {
  for (const c of clients) c.stop();
  await Promise.all([node1.close(), node2.close()]);
});

async function clientFor(node: RunningServer, user: TestUser, workspaceId: string) {
  const client = new ChatClient({
    api: new Api(node.url, user.token),
    wsUrl: `${node.url.replace(/^http/, "ws")}/ws`,
    token: user.token,
    me: { id: user.id, username: user.username },
    workspaceId,
    backoff: { minMs: 50, maxMs: 200 },
  });
  clients.push(client);
  await client.start();
  await eventually(() => client.getState().status === "online");
  return client;
}

const bodies = (c: ChatClient, channelId: string) =>
  c.getState().channels[channelId]!.timeline.messages.map((m) => m.body);

describe("ChatClient", () => {
  it("shows a sent message as pending, then confirmed, on both servers", async () => {
    const alice = await signup(node1.url, "alice");
    const bob = await signup(node1.url, "bob");
    const { workspaceId, generalId } = await workspaceWith(node1.url, alice, bob);
    const a = await clientFor(node1, alice, workspaceId);
    const b = await clientFor(node2, bob, workspaceId);
    await Promise.all([a.open(generalId), b.open(generalId)]);

    const pending = a.sendMessage(generalId, "hi bob");
    expect(a.getState().pending).toEqual([
      expect.objectContaining({ clientMsgId: pending.clientMsgId, status: "sending" }),
    ]);

    await eventually(() => bodies(b, generalId).includes("hi bob"));
    await eventually(() => a.getState().pending.length === 0);
    expect(bodies(a, generalId)).toEqual(["hi bob"]);
  });

  it("queues messages while offline and delivers each exactly once after reconnecting", async () => {
    const alice = await signup(node1.url, "alice");
    const bob = await signup(node1.url, "bob");
    const { workspaceId, generalId } = await workspaceWith(node1.url, alice, bob);
    const a = await clientFor(node1, alice, workspaceId);
    const b = await clientFor(node2, bob, workspaceId);
    await Promise.all([a.open(generalId), b.open(generalId)]);

    a.dropConnection();
    await eventually(() => a.getState().status === "offline");
    a.sendMessage(generalId, "written offline 1");
    a.sendMessage(generalId, "written offline 2");
    expect(a.getState().pending.map((p) => p.status)).toEqual(["sending", "sending"]);

    await eventually(() => a.getState().status === "online");
    await eventually(() => bodies(b, generalId).length === 2);
    expect(bodies(b, generalId)).toEqual(["written offline 1", "written offline 2"]);
    await eventually(() => a.getState().pending.length === 0);
  });

  it("catches up on everything it missed while disconnected, in order", async () => {
    const alice = await signup(node1.url, "alice");
    const bob = await signup(node1.url, "bob");
    const { workspaceId, generalId } = await workspaceWith(node1.url, alice, bob);
    const a = await clientFor(node1, alice, workspaceId);
    const b = await clientFor(node2, bob, workspaceId);
    await Promise.all([a.open(generalId), b.open(generalId)]);

    a.sendMessage(generalId, "before");
    await eventually(() => bodies(b, generalId).length === 1);

    b.dropConnection(); // bob's reconnect waits for backoff while alice keeps talking
    for (let i = 1; i <= 5; i++) a.sendMessage(generalId, `during ${i}`);
    await eventually(() => a.getState().pending.length === 0);

    await eventually(() => b.getState().status === "online");
    await eventually(() => bodies(b, generalId).length === 6);
    expect(bodies(b, generalId)).toEqual([
      "before",
      "during 1",
      "during 2",
      "during 3",
      "during 4",
      "during 5",
    ]);
    expect(b.getState().channels[generalId]!.timeline.head).toBe(6);
  });

  it("tracks unread counts, read state, typing and who's online", async () => {
    const alice = await signup(node1.url, "alice");
    const bob = await signup(node1.url, "bob");
    const { workspaceId, generalId } = await workspaceWith(node1.url, alice, bob);
    const a = await clientFor(node1, alice, workspaceId);
    const b = await clientFor(node2, bob, workspaceId);
    await a.open(generalId);

    await eventually(() => a.getState().online.has(bob.id) && b.getState().online.has(alice.id));

    b.typing(generalId);
    await eventually(() => Boolean(a.getState().typing[generalId]?.[bob.id]));

    a.sendMessage(generalId, "one");
    a.sendMessage(generalId, "two");
    // Bob hasn't opened the channel, but the unread count still updates live.
    await eventually(() => b.getState().channels[generalId]!.unread === 2);
    expect(a.getState().channels[generalId]!.unread).toBe(0);

    await b.open(generalId);
    b.markRead(generalId);
    expect(b.getState().channels[generalId]!.unread).toBe(0);
    await eventually(() => a.getState().reads[generalId]?.[bob.id] === 2); // "seen by bob"

    b.stop();
    await eventually(() => !a.getState().online.has(bob.id));
  });
});
