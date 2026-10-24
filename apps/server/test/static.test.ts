import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type RunningServer, startServer } from "../src/app.ts";
import { TEST_DB_URL, TEST_REDIS_URL } from "./env.ts";
import { api, signup, TestClient } from "./helpers.ts";

// Single-container mode: one process serves the web app, the API under /api and /ws.
let node: RunningServer;
let dist: string;

beforeAll(async () => {
  dist = await mkdtemp(join(tmpdir(), "parley-web-"));
  await mkdir(join(dist, "assets"));
  await writeFile(join(dist, "index.html"), "<!doctype html><title>parley</title>");
  await writeFile(join(dist, "assets", "app-abc123.js"), "console.log('parley')");
  await writeFile(join(tmpdir(), "parley-secret.txt"), "outside the web root");
  node = await startServer({
    databaseUrl: TEST_DB_URL,
    redisUrl: TEST_REDIS_URL,
    port: 0,
    host: "127.0.0.1",
    nodeId: "static-node",
    logLevel: "silent",
    staticDir: dist,
  });
});

afterAll(async () => {
  await node.close();
  await rm(dist, { recursive: true, force: true });
});

describe("single-container mode", () => {
  it("serves index.html at / and for client-side routes", async () => {
    for (const path of ["/", "/workspaces/123", "/missing.png"]) {
      const res = await fetch(node.url + path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.headers.get("cache-control")).toBe("no-cache");
      expect(await res.text()).toContain("<title>parley</title>");
    }
  });

  it("serves hashed assets with long-lived caching", async () => {
    const res = await fetch(`${node.url}/assets/app-abc123.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
    expect(res.headers.get("cache-control")).toContain("immutable");
  });

  it("does not serve files outside the web root", async () => {
    for (const path of ["/../parley-secret.txt", "/%2e%2e/parley-secret.txt"]) {
      const text = await (await fetch(node.url + path)).text();
      expect(text).not.toContain("outside the web root");
    }
  });

  it("mounts the API under /api", async () => {
    expect((await api(node.url, "/api/healthz")).status).toBe(200);
    const user = await signup(`${node.url}/api`, "static_user");
    expect((await api(node.url, "/api/me", { token: user.token })).body.user.username).toBe(user.username);
    expect((await api(node.url, "/api/nope")).status).toBe(404);
  });

  it("keeps metrics private", async () => {
    expect((await fetch(`${node.url}/api/metrics`)).status).toBe(404);
  });

  it("still accepts WebSocket connections on /ws", async () => {
    const user = await signup(`${node.url}/api`, "static_ws");
    const client = await TestClient.connect(node.url, user.token);
    client.ws.close();
  });
});
