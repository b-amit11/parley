import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunningServer } from "../src/app.ts";
import { api, signup, startNode, TestClient, workspaceWith } from "./helpers.ts";

let node: RunningServer;

beforeAll(async () => {
  node = await startNode("http-node");
});
afterAll(() => node.close());

describe("auth", () => {
  it("signs up, logs in and logs out", async () => {
    const user = await signup(node.url, "carol");
    expect((await api(node.url, "/me", { token: user.token })).body.user.username).toBe(user.username);

    const login = await api(node.url, "/auth/login", {
      body: { username: user.username, password: "correct horse" },
    });
    expect(login.status).toBe(200);

    await api(node.url, "/auth/logout", { method: "POST", token: login.body.token });
    expect((await api(node.url, "/me", { token: login.body.token })).status).toBe(401);
    expect((await api(node.url, "/me", { token: user.token })).status).toBe(200); // other session survives
  });

  it("rejects duplicate usernames, wrong passwords and bad input", async () => {
    const user = await signup(node.url, "dave");
    const dup = await api(node.url, "/auth/signup", {
      body: { username: user.username, password: "another password" },
    });
    expect(dup.status).toBe(409);
    const wrong = await api(node.url, "/auth/login", {
      body: { username: user.username, password: "wrong password" },
    });
    expect(wrong.status).toBe(401);
    const unknown = await api(node.url, "/auth/login", {
      body: { username: "nobody_here", password: "whatever123" },
    });
    expect(unknown.status).toBe(401);
    const bad = await api(node.url, "/auth/signup", { body: { username: "A!", password: "short" } });
    expect(bad.status).toBe(400);
  });

  it("requires a session for protected routes", async () => {
    expect((await api(node.url, "/workspaces")).status).toBe(401);
    expect((await api(node.url, "/workspaces", { token: "garbage" })).status).toBe(401);
  });
});

describe("workspaces and channels", () => {
  it("only lets the owner invite, and new members join #general", async () => {
    const owner = await signup(node.url, "owner");
    const member = await signup(node.url, "member");
    const outsider = await signup(node.url, "outsider");
    const { workspaceId } = await workspaceWith(node.url, owner, member);

    const invite = await api(node.url, `/workspaces/${workspaceId}/members`, {
      token: member.token,
      body: { username: outsider.username },
    });
    expect(invite.status).toBe(403);

    const channels = await api(node.url, `/workspaces/${workspaceId}/channels`, { token: member.token });
    expect(channels.body.channels).toEqual([
      expect.objectContaining({ name: "general", kind: "public", joined: true, lastSeq: 0 }),
    ]);
    expect(
      (await api(node.url, `/workspaces/${workspaceId}/channels`, { token: outsider.token })).status,
    ).toBe(404);
  });

  it("hides private channels from non-members until they're added", async () => {
    const owner = await signup(node.url, "owner");
    const member = await signup(node.url, "member");
    const { workspaceId } = await workspaceWith(node.url, owner, member);
    const secret = await api(node.url, `/workspaces/${workspaceId}/channels`, {
      token: owner.token,
      body: { name: "secret", kind: "private" },
    });
    expect(secret.status).toBe(201);

    const names = async () =>
      (await api(node.url, `/workspaces/${workspaceId}/channels`, { token: member.token })).body.channels.map(
        (c: { name: string }) => c.name,
      );
    expect(await names()).toEqual(["general"]);
    expect(
      (
        await api(node.url, `/channels/${secret.body.channel.id}/join`, {
          method: "POST",
          token: member.token,
        })
      ).status,
    ).toBe(404);

    await api(node.url, `/channels/${secret.body.channel.id}/members`, {
      token: owner.token,
      body: { username: member.username },
    });
    expect(await names()).toEqual(["general", "secret"]);
  });

  it("rejects duplicate channel names", async () => {
    const owner = await signup(node.url, "owner");
    const { workspaceId } = await workspaceWith(node.url, owner);
    const r = await api(node.url, `/workspaces/${workspaceId}/channels`, {
      token: owner.token,
      body: { name: "general" },
    });
    expect(r.status).toBe(409);
  });

  it("returns the same DM channel for a pair, whoever opens it", async () => {
    const a = await signup(node.url, "a");
    const b = await signup(node.url, "b");
    const { workspaceId } = await workspaceWith(node.url, a, b);
    const [first, second] = await Promise.all([
      api(node.url, `/workspaces/${workspaceId}/dms`, { token: a.token, body: { username: b.username } }),
      api(node.url, `/workspaces/${workspaceId}/dms`, { token: b.token, body: { username: a.username } }),
    ]);
    expect(first.body.channel.id).toBe(second.body.channel.id);
    expect(first.body.channel.kind).toBe("dm");
  });

  it("lists workspace members, and names the other person in a DM", async () => {
    const a = await signup(node.url, "a");
    const b = await signup(node.url, "b");
    const { workspaceId } = await workspaceWith(node.url, a, b);
    await api(node.url, `/workspaces/${workspaceId}/dms`, { token: a.token, body: { username: b.username } });

    const members = await api(node.url, `/workspaces/${workspaceId}/members`, { token: b.token });
    expect(members.body.members.map((m: { id: string; role: string }) => [m.id, m.role]).sort()).toEqual(
      [
        [a.id, "owner"],
        [b.id, "member"],
      ].sort(),
    );
    const channels = await api(node.url, `/workspaces/${workspaceId}/channels`, { token: b.token });
    const dm = channels.body.channels.find((c: { kind: string }) => c.kind === "dm");
    expect(dm).toMatchObject({ dmUserId: a.id, name: null });
  });
});

describe("history", () => {
  it("pages backwards from the newest message", async () => {
    const owner = await signup(node.url, "owner");
    const { generalId } = await workspaceWith(node.url, owner);
    const ws = await TestClient.connect(node.url, owner.token);
    for (let i = 1; i <= 5; i++) await ws.post(generalId, `m${i}`);
    await ws.close();

    const page1 = await api(node.url, `/channels/${generalId}/messages?limit=2`, { token: owner.token });
    expect(page1.body.messages.map((m: { body: string }) => m.body)).toEqual(["m4", "m5"]);
    expect(page1.body.hasMore).toBe(true);
    const page2 = await api(node.url, `/channels/${generalId}/messages?limit=10&before=4`, {
      token: owner.token,
    });
    expect(page2.body.messages.map((m: { body: string }) => m.body)).toEqual(["m1", "m2", "m3"]);
    expect(page2.body.hasMore).toBe(false);
  });
});

describe("metrics", () => {
  it("exposes Prometheus metrics", async () => {
    const res = await fetch(`${node.url}/metrics`);
    const text = await res.text();
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(text).toContain("parley_ws_connections");
    expect(text).toContain("parley_send_duration_seconds_bucket");
  });
});

describe("health", () => {
  it("reports Postgres and Redis status", async () => {
    expect(await api(node.url, "/healthz")).toEqual({ status: 200, body: { postgres: true, redis: true } });
  });
});
