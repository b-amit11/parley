/** Data access. Every query that reads or writes channel content checks membership in the same SQL. */
import type { Message } from "@parley/shared";
import { hashToken, newSessionToken } from "./auth.ts";
import { type Db, isUniqueViolation, type Tx, withTransaction } from "./db.ts";

export type User = { id: string; username: string };
export type ChannelKind = "public" | "private" | "dm";
export type Channel = {
  id: string;
  workspaceId: string;
  kind: ChannelKind;
  name: string | null;
  lastSeq: number;
};
export type ChannelSummary = Channel & { joined: boolean; lastReadSeq: number };

const SESSION_TTL_DAYS = 30;

// ── users and sessions ────────────────────────────────────────────────────────

export async function createUser(db: Db, username: string, passwordHash: string): Promise<User | null> {
  try {
    const r = await db.query<User>(
      "INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username",
      [username, passwordHash],
    );
    return r.rows[0] ?? null;
  } catch (err) {
    if (isUniqueViolation(err)) return null;
    throw err;
  }
}

export async function findUserByUsername(
  db: Db,
  username: string,
): Promise<(User & { passwordHash: string }) | null> {
  const r = await db.query<User & { passwordHash: string }>(
    `SELECT id, username, password_hash AS "passwordHash" FROM users WHERE username = $1`,
    [username],
  );
  return r.rows[0] ?? null;
}

export async function createSession(db: Db, userId: string): Promise<string> {
  const token = newSessionToken();
  await db.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at)
     VALUES ($1, $2, now() + make_interval(days => $3))`,
    [hashToken(token), userId, SESSION_TTL_DAYS],
  );
  return token;
}

export async function userForToken(db: Db, token: string): Promise<User | null> {
  const r = await db.query<User>(
    `SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(token)],
  );
  return r.rows[0] ?? null;
}

export async function deleteSession(db: Db, token: string): Promise<void> {
  await db.query("DELETE FROM sessions WHERE token_hash = $1", [hashToken(token)]);
}

// ── workspaces ────────────────────────────────────────────────────────────────

export type Workspace = { id: string; name: string; role: "owner" | "member" };

export async function createWorkspace(db: Db, name: string, ownerId: string): Promise<Workspace> {
  return withTransaction(db, async (tx) => {
    const ws = await tx.query<{ id: string }>(
      "INSERT INTO workspaces (name, created_by) VALUES ($1, $2) RETURNING id",
      [name, ownerId],
    );
    const id = ws.rows[0]!.id;
    await tx.query("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')", [
      id,
      ownerId,
    ]);
    await insertChannel(tx, id, "public", "general", ownerId);
    return { id, name, role: "owner" };
  });
}

export async function listWorkspaces(db: Db, userId: string): Promise<Workspace[]> {
  const r = await db.query<Workspace>(
    `SELECT w.id, w.name, m.role FROM workspaces w
     JOIN workspace_members m ON m.workspace_id = w.id
     WHERE m.user_id = $1 ORDER BY w.created_at`,
    [userId],
  );
  return r.rows;
}

export async function workspaceRole(db: Db | Tx, workspaceId: string, userId: string) {
  const r = await db.query<{ role: "owner" | "member" }>(
    "SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
    [workspaceId, userId],
  );
  return r.rows[0]?.role ?? null;
}

/** Adds a member to the workspace and to its #general channel. Returns false if they were already a member. */
export async function addWorkspaceMember(db: Db, workspaceId: string, userId: string): Promise<boolean> {
  return withTransaction(db, async (tx) => {
    const r = await tx.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'member')
       ON CONFLICT DO NOTHING`,
      [workspaceId, userId],
    );
    await tx.query(
      `INSERT INTO channel_members (channel_id, user_id)
       SELECT id, $2 FROM channels WHERE workspace_id = $1 AND name = 'general'
       ON CONFLICT DO NOTHING`,
      [workspaceId, userId],
    );
    return (r.rowCount ?? 0) > 0;
  });
}

// ── channels ──────────────────────────────────────────────────────────────────

const CHANNEL_COLUMNS = `c.id, c.workspace_id AS "workspaceId", c.kind, c.name, c.last_seq AS "lastSeq"`;

async function insertChannel(
  tx: Tx,
  workspaceId: string,
  kind: ChannelKind,
  name: string | null,
  creatorId: string,
  dmKey: string | null = null,
): Promise<Channel> {
  const r = await tx.query<Channel>(
    `INSERT INTO channels AS c (workspace_id, kind, name, dm_key) VALUES ($1, $2, $3, $4)
     RETURNING ${CHANNEL_COLUMNS}`,
    [workspaceId, kind, name, dmKey],
  );
  const channel = r.rows[0]!;
  await tx.query("INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)", [
    channel.id,
    creatorId,
  ]);
  return channel;
}

export type CreateChannelResult = { channel: Channel } | { error: "forbidden" | "name_taken" };

export async function createChannel(
  db: Db,
  workspaceId: string,
  kind: "public" | "private",
  name: string,
  creatorId: string,
): Promise<CreateChannelResult> {
  try {
    return await withTransaction(db, async (tx) => {
      if (!(await workspaceRole(tx, workspaceId, creatorId))) return { error: "forbidden" as const };
      return { channel: await insertChannel(tx, workspaceId, kind, name, creatorId) };
    });
  } catch (err) {
    if (isUniqueViolation(err)) return { error: "name_taken" };
    throw err;
  }
}

/** Channels the user can see in a workspace: public channels plus anything they're a member of. */
export async function listChannels(db: Db, workspaceId: string, userId: string): Promise<ChannelSummary[]> {
  const r = await db.query<ChannelSummary>(
    `SELECT ${CHANNEL_COLUMNS}, (cm.user_id IS NOT NULL) AS joined,
            COALESCE(rc.last_read_seq, 0) AS "lastReadSeq"
     FROM channels c
     JOIN workspace_members wm ON wm.workspace_id = c.workspace_id AND wm.user_id = $2
     LEFT JOIN channel_members cm ON cm.channel_id = c.id AND cm.user_id = $2
     LEFT JOIN read_cursors rc ON rc.channel_id = c.id AND rc.user_id = $2
     WHERE c.workspace_id = $1 AND (c.kind = 'public' OR cm.user_id IS NOT NULL)
     ORDER BY (c.kind = 'dm'), c.name, c.created_at`,
    [workspaceId, userId],
  );
  return r.rows;
}

/** Joins a public channel. Only members of its workspace can join. */
export async function joinChannel(db: Db, channelId: string, userId: string): Promise<boolean> {
  const r = await db.query(
    `INSERT INTO channel_members (channel_id, user_id)
     SELECT c.id, $2 FROM channels c
     JOIN workspace_members wm ON wm.workspace_id = c.workspace_id AND wm.user_id = $2
     WHERE c.id = $1 AND c.kind = 'public'
     ON CONFLICT DO NOTHING RETURNING channel_id`,
    [channelId, userId],
  );
  return (r.rowCount ?? 0) > 0 || (await isMember(db, channelId, userId));
}

/** A channel member adds another member of the workspace to a private channel. */
export async function addChannelMember(
  db: Db,
  channelId: string,
  actorId: string,
  userId: string,
): Promise<boolean> {
  const r = await db.query(
    `INSERT INTO channel_members (channel_id, user_id)
     SELECT c.id, $3 FROM channels c
     JOIN channel_members actor ON actor.channel_id = c.id AND actor.user_id = $2
     JOIN workspace_members wm ON wm.workspace_id = c.workspace_id AND wm.user_id = $3
     WHERE c.id = $1 AND c.kind = 'private'
     ON CONFLICT DO NOTHING RETURNING channel_id`,
    [channelId, actorId, userId],
  );
  return (r.rowCount ?? 0) > 0 || (await isMember(db, channelId, userId));
}

/** Gets or creates the one DM channel for a pair of workspace members. */
export async function getOrCreateDm(
  db: Db,
  workspaceId: string,
  userId: string,
  otherId: string,
): Promise<Channel | null> {
  const dmKey = [userId, otherId].sort().join(":");
  return withTransaction(db, async (tx) => {
    const members = await tx.query(
      "SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = ANY($2)",
      [workspaceId, [userId, otherId]],
    );
    if (members.rowCount !== new Set([userId, otherId]).size) return null;
    const existing = await tx.query<Channel>(
      `SELECT ${CHANNEL_COLUMNS} FROM channels c WHERE workspace_id = $1 AND dm_key = $2`,
      [workspaceId, dmKey],
    );
    if (existing.rows[0]) return existing.rows[0];
    // ON CONFLICT doesn't apply here because both users must also be added, so a concurrent
    // create is handled by catching the unique violation instead.
    await tx.query("SAVEPOINT dm");
    try {
      const channel = await insertChannel(tx, workspaceId, "dm", null, userId, dmKey);
      if (otherId !== userId) {
        await tx.query("INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)", [
          channel.id,
          otherId,
        ]);
      }
      return channel;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      await tx.query("ROLLBACK TO SAVEPOINT dm");
      const r = await tx.query<Channel>(
        `SELECT ${CHANNEL_COLUMNS} FROM channels c WHERE workspace_id = $1 AND dm_key = $2`,
        [workspaceId, dmKey],
      );
      return r.rows[0] ?? null;
    }
  });
}

export async function isMember(db: Db, channelId: string, userId: string): Promise<boolean> {
  const r = await db.query("SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2", [
    channelId,
    userId,
  ]);
  return (r.rowCount ?? 0) > 0;
}

/** Which of the given channels the user is a member of. */
export async function memberChannels(db: Db, userId: string, channelIds: string[]): Promise<Set<string>> {
  const r = await db.query<{ channel_id: string }>(
    "SELECT channel_id FROM channel_members WHERE user_id = $1 AND channel_id = ANY($2::uuid[])",
    [userId, channelIds],
  );
  return new Set(r.rows.map((row) => row.channel_id));
}

// ── messages ──────────────────────────────────────────────────────────────────

const MESSAGE_COLUMNS = `id, channel_id AS "channelId", seq, sender_id AS "senderId", body,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"`;

export type SendInput = { channelId: string; senderId: string; clientMsgId: string; body: string };
export type SendResult =
  | { message: Message; duplicate: boolean }
  | { error: "forbidden" | "client_id_reused" };

class DuplicateSend extends Error {}

/**
 * Stores a message with the next sequence number for its channel.
 *
 * Idempotent: retrying with the same (sender, clientMsgId) returns the original message.
 * Gapless: if a concurrent retry wins the race, this transaction rolls back, which also undoes its
 * last_seq increment, so seq values stay contiguous.
 */
export async function sendMessage(db: Db, input: SendInput): Promise<SendResult> {
  const existing = await findByClientMsgId(db, input.senderId, input.clientMsgId);
  if (existing) return sameChannel(existing, input);
  try {
    return await withTransaction(db, async (tx) => {
      // The membership check and the sequence increment happen in one statement. The row lock
      // taken here serializes all sends to this channel.
      const seq = await tx.query<{ last_seq: number }>(
        `UPDATE channels SET last_seq = last_seq + 1
         WHERE id = $1 AND EXISTS (
           SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2)
         RETURNING last_seq`,
        [input.channelId, input.senderId],
      );
      const next = seq.rows[0]?.last_seq;
      if (next === undefined) return { error: "forbidden" as const };
      const inserted = await tx.query<Message>(
        `INSERT INTO messages (channel_id, seq, sender_id, client_msg_id, body)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (sender_id, client_msg_id) DO NOTHING
         RETURNING ${MESSAGE_COLUMNS}`,
        [input.channelId, next, input.senderId, input.clientMsgId, input.body],
      );
      if (!inserted.rows[0]) throw new DuplicateSend();
      return { message: inserted.rows[0], duplicate: false };
    });
  } catch (err) {
    if (!(err instanceof DuplicateSend)) throw err;
    const winner = await findByClientMsgId(db, input.senderId, input.clientMsgId);
    if (!winner) throw err;
    return sameChannel(winner, input);
  }
}

function sameChannel(message: Message, input: SendInput): SendResult {
  return message.channelId === input.channelId ? { message, duplicate: true } : { error: "client_id_reused" };
}

async function findByClientMsgId(db: Db, senderId: string, clientMsgId: string) {
  const r = await db.query<Message>(
    `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE sender_id = $1 AND client_msg_id = $2`,
    [senderId, clientMsgId],
  );
  return r.rows[0] ?? null;
}

/** Messages after a seq, oldest first: what a client needs to catch up. */
export async function messagesAfter(
  db: Db,
  channelId: string,
  afterSeq: number,
  limit: number,
): Promise<{ messages: Message[]; hasMore: boolean }> {
  const r = await db.query<Message>(
    `SELECT ${MESSAGE_COLUMNS} FROM messages
     WHERE channel_id = $1 AND seq > $2 ORDER BY seq LIMIT $3`,
    [channelId, afterSeq, limit + 1],
  );
  return { messages: r.rows.slice(0, limit), hasMore: r.rows.length > limit };
}

/** Messages before a seq (or the latest ones), returned oldest first: for scrolling back through history. */
export async function messagesBefore(
  db: Db,
  channelId: string,
  beforeSeq: number | null,
  limit: number,
): Promise<{ messages: Message[]; hasMore: boolean }> {
  const r = await db.query<Message>(
    `SELECT ${MESSAGE_COLUMNS} FROM messages
     WHERE channel_id = $1 AND ($2::bigint IS NULL OR seq < $2) ORDER BY seq DESC LIMIT $3`,
    [channelId, beforeSeq, limit + 1],
  );
  return { messages: r.rows.slice(0, limit).reverse(), hasMore: r.rows.length > limit };
}
