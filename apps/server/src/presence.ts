/**
 * Who is online, stored in Redis so every server agrees.
 *
 * - `presence:conns:<userId>` is a sorted set of that user's connection ids, each scored by its
 *   expiry time. Several tabs or devices count as one online user.
 * - `presence:online` is a sorted set of user ids, each scored by its latest connection expiry.
 *
 * Every server refreshes the expiry of its own connections on a heartbeat. If a server crashes,
 * its entries simply expire. A sweep, run by every server, atomically removes users whose
 * connections have all expired, so each "went offline" event is published exactly once, by
 * whichever server removed the user. All scripts use Redis's clock.
 */
import type { Redis } from "ioredis";

const ONLINE = "presence:online";
const connsKey = (userId: string) => `presence:conns:${userId}`;

const NOW = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
`;

/** Adds or refreshes a connection. Returns 1 if the user just came online. */
const TOUCH = `${NOW}
local expires = now + tonumber(ARGV[2])
local previous = tonumber(redis.call('ZSCORE', KEYS[2], ARGV[3]))
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
redis.call('ZADD', KEYS[1], expires, ARGV[1])
redis.call('PEXPIRE', KEYS[1], ARGV[2])
redis.call('ZADD', KEYS[2], 'GT', expires, ARGV[3])
if previous and previous > now then return 0 end
return 1
`;

/** Removes a connection. Returns 1 if that was the user's last live connection. */
const DROP = `${NOW}
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
local top = redis.call('ZRANGE', KEYS[1], -1, -1, 'WITHSCORES')
if #top == 0 then
  local removed = redis.call('ZREM', KEYS[2], ARGV[2])
  return removed
end
redis.call('ZADD', KEYS[2], top[2], ARGV[2])
return 0
`;

/** Removes users whose connections have all expired, and returns them. */
const SWEEP = `${NOW}
local users = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now, 'LIMIT', 0, tonumber(ARGV[1]))
local gone = {}
for _, user in ipairs(users) do
  local key = ARGV[2] .. user
  redis.call('ZREMRANGEBYSCORE', key, '-inf', now)
  local top = redis.call('ZRANGE', key, -1, -1, 'WITHSCORES')
  if #top == 0 then
    redis.call('ZREM', KEYS[1], user)
    table.insert(gone, user)
  else
    redis.call('ZADD', KEYS[1], top[2], user)
  end
end
return gone
`;

const ONLINE_AMONG = `${NOW}
local online = {}
for _, user in ipairs(ARGV) do
  local score = tonumber(redis.call('ZSCORE', KEYS[1], user))
  if score and score > now then table.insert(online, user) end
end
return online
`;

type WithScripts = Redis & {
  presenceTouch(
    conns: string,
    online: string,
    connId: string,
    ttlMs: number,
    userId: string,
  ): Promise<number>;
  presenceDrop(conns: string, online: string, connId: string, userId: string): Promise<number>;
  presenceSweep(online: string, limit: number, prefix: string): Promise<string[]>;
  presenceOnlineAmong(online: string, ...userIds: string[]): Promise<string[]>;
};

export class Presence {
  private readonly redis: WithScripts;

  constructor(
    redis: Redis,
    readonly ttlMs: number,
  ) {
    redis.defineCommand("presenceTouch", { numberOfKeys: 2, lua: TOUCH });
    redis.defineCommand("presenceDrop", { numberOfKeys: 2, lua: DROP });
    redis.defineCommand("presenceSweep", { numberOfKeys: 1, lua: SWEEP });
    redis.defineCommand("presenceOnlineAmong", { numberOfKeys: 1, lua: ONLINE_AMONG });
    this.redis = redis as WithScripts;
  }

  /** Registers or refreshes a connection. Returns true if the user just came online. */
  async touch(userId: string, connId: string): Promise<boolean> {
    return (await this.redis.presenceTouch(connsKey(userId), ONLINE, connId, this.ttlMs, userId)) === 1;
  }

  /** Refreshes many connections in one round trip (the heartbeat). Returns users who came online. */
  async touchMany(conns: { userId: string; connId: string }[]): Promise<string[]> {
    if (!conns.length) return [];
    // Commands added with defineCommand also exist on pipelines, but ioredis's types don't show them.
    const pipeline: any = this.redis.pipeline();
    for (const c of conns) pipeline.presenceTouch(connsKey(c.userId), ONLINE, c.connId, this.ttlMs, c.userId);
    const results = (await pipeline.exec()) as [Error | null, number][];
    return conns.filter((_, i) => results[i]?.[1] === 1).map((c) => c.userId);
  }

  /** Removes a connection. Returns true if it was the user's last one. */
  async drop(userId: string, connId: string): Promise<boolean> {
    return (await this.redis.presenceDrop(connsKey(userId), ONLINE, connId, userId)) === 1;
  }

  /** Users whose connections all expired (for example because their server crashed). */
  async sweep(limit = 500): Promise<string[]> {
    return this.redis.presenceSweep(ONLINE, limit, "presence:conns:");
  }

  async onlineAmong(userIds: string[]): Promise<string[]> {
    if (!userIds.length) return [];
    return this.redis.presenceOnlineAmong(ONLINE, ...userIds);
  }
}
