/**
 * Demo data for local development: `npm run seed`.
 * Users alice, bob and carol (password: DEMO_PASSWORD, default "parley-demo") in a "Demo team"
 * workspace, with a little conversation in #general.
 */
import { randomUUID } from "node:crypto";
import { hashPassword } from "./auth.ts";
import { configFromEnv } from "./config.ts";
import { createPool, migrate } from "./db.ts";
import * as store from "./store.ts";

const PASSWORD = process.env.DEMO_PASSWORD ?? "parley-demo";
const db = createPool(configFromEnv().databaseUrl);
await migrate(db);

const users: store.User[] = [];
for (const username of ["alice", "bob", "carol"]) {
  const user =
    (await store.createUser(db, username, await hashPassword(PASSWORD))) ??
    (await store.findUserByUsername(db, username));
  users.push({ id: user!.id, username });
}
const [alice, bob, carol] = users as [store.User, store.User, store.User];

const existing = (await store.listWorkspaces(db, alice.id)).find((w) => w.name === "Demo team");
if (existing) {
  console.log("Demo data already exists.");
} else {
  const ws = await store.createWorkspace(db, "Demo team", alice.id);
  await store.addWorkspaceMember(db, ws.id, bob.id);
  await store.addWorkspaceMember(db, ws.id, carol.id);
  const general = (await store.listChannels(db, ws.id, alice.id)).find((c) => c.name === "general")!;
  const created = await store.createChannel(db, ws.id, "public", "engineering", alice.id);
  if ("channel" in created) await store.joinChannel(db, created.channel.id, bob.id);
  const lines: [store.User, string][] = [
    [alice, "Welcome to parley 👋"],
    [bob, "Hey! Is this the one that survives a server crash?"],
    [alice, "Yep. Kill a node mid-conversation and clients reconnect and catch up from their last seq."],
    [carol, "And retries don't create duplicates?"],
    [alice, "Exactly once on screen: the clientMsgId makes every retry idempotent."],
  ];
  for (const [user, body] of lines) {
    await store.sendMessage(db, {
      channelId: general.id,
      senderId: user.id,
      clientMsgId: randomUUID(),
      body,
    });
  }
  console.log(`Seeded "Demo team" with ${users.map((u) => u.username).join(", ")} (password: ${PASSWORD}).`);
}
await db.end();
