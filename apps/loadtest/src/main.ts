/**
 * Load and chaos test against a running cluster, using the real ChatClient (the browser's code).
 *
 *   npm run loadtest -- --url http://localhost:8080 --channels 50 --members 20 --rate 0.5 --duration 60 [--chaos]
 *
 * Each channel lives in its own small workspace with `members` users, and every user sends `rate`
 * messages per second. With --chaos, one server is SIGKILLed halfway through and restarted 10 s
 * later. Afterwards every client's timeline is checked against Postgres: each one must hold every
 * message in its channel exactly once, in order.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { parseArgs } from "node:util";
import type { Message } from "@parley/shared";
import pg from "pg";
import { Api } from "../../web/src/lib/api.ts";
import { ChatClient } from "../../web/src/lib/client.ts";

const { values: args } = parseArgs({
  options: {
    url: { type: "string", default: "http://localhost:8080" },
    db: {
      type: "string",
      default: process.env.DATABASE_URL ?? "postgres://parley:parley@localhost:5433/parley",
    },
    channels: { type: "string", default: "50" },
    members: { type: "string", default: "20" },
    rate: { type: "string", default: "0.5" },
    duration: { type: "string", default: "60" },
    chaos: { type: "boolean", default: false },
    "kill-service": { type: "string", default: "server2" },
    out: { type: "string" },
  },
});
const CHANNELS = Number(args.channels);
const MEMBERS = Number(args.members);
const RATE = Number(args.rate);
const DURATION_S = Number(args.duration);
const API = `${args.url}/api`;
const WS = `${args.url!.replace(/^http/, "ws")}/ws`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

// ── setup: users, sessions and channels straight into Postgres (hashing passwords for
//    thousands of users through the API would take minutes and isn't what's being measured) ──

type Seat = { userId: string; token: string; workspaceId: string; channelId: string };

async function setup(db: pg.Pool): Promise<Seat[]> {
  const run = randomBytes(3).toString("hex");
  const seats: Seat[] = [];
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    for (let c = 0; c < CHANNELS; c++) {
      const users = Array.from({ length: MEMBERS }, (_, m) => ({
        id: randomUUID(),
        username: `lt${run}_${c}_${m}`,
        token: randomBytes(24).toString("base64url"),
      }));
      await client.query(
        `INSERT INTO users (id, username, password_hash) SELECT * FROM unnest($1::uuid[], $2::text[], $3::text[])`,
        [users.map((u) => u.id), users.map((u) => u.username), users.map(() => "disabled")],
      );
      await client.query(
        `INSERT INTO sessions (token_hash, user_id, expires_at)
         SELECT * FROM unnest($1::bytea[], $2::uuid[], array_fill(now() + interval '1 day', ARRAY[$3::int]))`,
        [users.map((u) => createHash("sha256").update(u.token).digest()), users.map((u) => u.id), MEMBERS],
      );
      const ws = await client.query<{ id: string }>(
        "INSERT INTO workspaces (name, created_by) VALUES ($1, $2) RETURNING id",
        [`loadtest ${run} #${c}`, users[0]!.id],
      );
      const workspaceId = ws.rows[0]!.id;
      await client.query(
        `INSERT INTO workspace_members (workspace_id, user_id, role)
         SELECT $1, u, CASE WHEN i = 1 THEN 'owner' ELSE 'member' END FROM unnest($2::uuid[]) WITH ORDINALITY AS t(u, i)`,
        [workspaceId, users.map((u) => u.id)],
      );
      const ch = await client.query<{ id: string }>(
        "INSERT INTO channels (workspace_id, kind, name) VALUES ($1, 'public', 'load') RETURNING id",
        [workspaceId],
      );
      const channelId = ch.rows[0]!.id;
      await client.query("INSERT INTO channel_members (channel_id, user_id) SELECT $1, unnest($2::uuid[])", [
        channelId,
        users.map((u) => u.id),
      ]);
      for (const u of users) seats.push({ userId: u.id, token: u.token, workspaceId, channelId });
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  log(`created ${seats.length} users in ${CHANNELS} channels (run ${run})`);
  return seats;
}

// ── measurement ─────────────────────────────────────────────────────────────

const ackMs: number[] = [];
const liveMs: number[] = [];
let recoveredBySync = 0;
let reconnects = 0;

function sentAt(m: Message): number | null {
  const match = /^t=(\d+) /.exec(m.body);
  return match ? Number(match[1]) : null;
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

function summary(values: number[]) {
  const s = [...values].sort((a, b) => a - b);
  return {
    count: s.length,
    p50: percentile(s, 50),
    p95: percentile(s, 95),
    p99: percentile(s, 99),
    max: s[s.length - 1] ?? 0,
  };
}

// ── run ─────────────────────────────────────────────────────────────────────

async function main() {
  const db = new pg.Pool({ connectionString: args.db, max: 4 });
  const seats = await setup(db);
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();

  // Connect gradually, as real clients would, instead of all in the same millisecond.
  const clients: { seat: Seat; client: ChatClient; seen: Set<number> }[] = [];
  const t0 = Date.now();
  for (const [i, seat] of seats.entries()) {
    const seen = new Set<number>();
    const client = new ChatClient({
      api: new Api(API, seat.token),
      wsUrl: WS,
      token: seat.token,
      me: { id: seat.userId, username: seat.userId },
      workspaceId: seat.workspaceId,
      backoff: { minMs: 250, maxMs: 4000 },
      refreshMs: 3_600_000,
      onMessage: (m, via) => {
        const t = sentAt(m);
        if (t === null) return;
        if (via === "ack") return void ackMs.push(Date.now() - t);
        if (m.senderId === seat.userId || seen.has(m.seq)) return;
        seen.add(m.seq);
        if (via === "live") liveMs.push(Date.now() - t);
        else recoveredBySync++;
      },
    });
    let lastStatus = "connecting";
    client.subscribe(() => {
      const status = client.getState().status;
      if (status !== lastStatus && status === "offline" && lastStatus === "online") reconnects++;
      lastStatus = status;
    });
    clients.push({ seat, client, seen });
    void client.start().then(() => client.open(seat.channelId));
    if (i % 100 === 99) await sleep(200);
  }
  const allOnline = () => clients.every((c) => c.client.getState().status === "online");
  while (!allOnline()) {
    if (Date.now() - t0 > 120_000) throw new Error("clients failed to connect within 2 minutes");
    await sleep(250);
  }
  await sleep(1000);
  log(`${clients.length} clients connected in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  // Send phase.
  loop.reset();
  const sendStart = Date.now();
  const sendEnd = sendStart + DURATION_S * 1000;
  let sent = 0;
  let chaos: { killedAt: number; restartedAt?: number } | undefined;
  const senders = clients.map(async ({ seat, client }) => {
    await sleep(Math.random() * (1000 / RATE));
    while (Date.now() < sendEnd) {
      client.sendMessage(seat.channelId, `t=${Date.now()} ${randomBytes(6).toString("hex")}`);
      sent++;
      // Exponential gaps: arrivals behave like a Poisson process instead of in lockstep.
      await sleep(Math.min(sendEnd - Date.now(), (-Math.log(1 - Math.random()) / RATE) * 1000));
    }
  });
  const ticker = setInterval(() => {
    const elapsed = (Date.now() - sendStart) / 1000;
    log(
      `t=${elapsed.toFixed(0)}s sent=${sent} acked=${ackMs.length} delivered=${liveMs.length} reconnects=${reconnects}`,
    );
  }, 10_000);
  if (args.chaos) {
    await sleep((DURATION_S * 1000) / 2);
    log(`CHAOS: SIGKILL ${args["kill-service"]}`);
    execFileSync("docker", ["compose", "kill", "-s", "SIGKILL", args["kill-service"]!], { stdio: "ignore" });
    chaos = { killedAt: (Date.now() - sendStart) / 1000 };
    await sleep(10_000);
    execFileSync("docker", ["compose", "start", args["kill-service"]!], { stdio: "ignore" });
    chaos.restartedAt = (Date.now() - sendStart) / 1000;
    log(`CHAOS: restarted ${args["kill-service"]}`);
  }
  await Promise.all(senders);
  clearInterval(ticker);
  const sendSeconds = (Date.now() - sendStart) / 1000;
  const loopP99 = loop.percentile(99) / 1e6;

  // Drain: wait for every pending send to be acked and every client to catch up.
  log("sending stopped; waiting for clients to drain");
  const truth = new Map<string, number>();
  const drainStart = Date.now();
  const caughtUp = async () => {
    const r = await db.query<{ id: string; last_seq: number }>(
      "SELECT id, last_seq::int FROM channels WHERE id = ANY($1::uuid[])",
      [[...new Set(seats.map((s) => s.channelId))]],
    );
    for (const row of r.rows) truth.set(row.id, row.last_seq);
    return clients.every(
      ({ seat, client }) =>
        client.getState().pending.length === 0 &&
        client.getState().channels[seat.channelId]?.timeline.head === truth.get(seat.channelId),
    );
  };
  while (!(await caughtUp()) && Date.now() - drainStart < 60_000) await sleep(500);

  // Verify: every client holds every message of its channel exactly once, in order.
  let missing = 0;
  let duplicates = 0;
  let outOfOrder = 0;
  let unacked = 0;
  for (const { seat, client } of clients) {
    const state = client.getState();
    unacked += state.pending.length;
    const msgs = state.channels[seat.channelId]?.timeline.messages ?? [];
    const expected = truth.get(seat.channelId) ?? 0;
    duplicates += msgs.length - new Set(msgs.map((m) => m.id)).size;
    msgs.forEach((m, i) => {
      if (m.seq !== i + 1) outOfOrder++;
    });
    missing += Math.max(0, expected - new Set(msgs.map((m) => m.seq)).size);
  }
  const gaps = await db.query<{ gaps: number }>(
    `SELECT count(*)::int AS gaps FROM channels c
     WHERE c.id = ANY($1::uuid[]) AND c.last_seq <> (SELECT count(*) FROM messages m WHERE m.channel_id = c.id)`,
    [[...new Set(seats.map((s) => s.channelId))]],
  );

  const stored = [...truth.values()].reduce((a, b) => a + b, 0);
  const result = {
    config: {
      url: args.url,
      channels: CHANNELS,
      members: MEMBERS,
      connections: clients.length,
      ratePerUser: RATE,
      durationS: DURATION_S,
      chaos: args.chaos,
    },
    throughput: {
      sent,
      stored,
      sendsPerSecond: Number((sent / sendSeconds).toFixed(1)),
      deliveriesPerSecond: Number(((liveMs.length + recoveredBySync) / sendSeconds).toFixed(1)),
    },
    ackLatencyMs: summary(ackMs),
    deliveryLatencyMs: summary(liveMs),
    recoveredBySync,
    reconnects,
    chaos,
    correctness: { missing, duplicates, outOfOrder, unacked, channelsWithSeqGaps: gaps.rows[0]!.gaps },
    loadGeneratorEventLoopP99Ms: Number(loopP99.toFixed(1)),
    drainSeconds: Number(((Date.now() - drainStart) / 1000).toFixed(1)),
  };
  console.log(JSON.stringify(result, null, 2));
  if (args.out) {
    // npm runs workspace scripts from the package folder; resolve against where it was invoked.
    const out = resolve(process.env.INIT_CWD ?? process.cwd(), args.out);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  }

  for (const { client } of clients) client.stop();
  await db.end();
  const ok =
    missing === 0 && duplicates === 0 && outOfOrder === 0 && unacked === 0 && gaps.rows[0]!.gaps === 0;
  log(ok ? "PASS: every client has every message exactly once, in order" : "FAIL: see correctness above");
  process.exit(ok ? 0 : 1);
}

await main();
