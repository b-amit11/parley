/**
 * Token-bucket rate limiting in Redis. The Lua script runs atomically, so a user's limit holds
 * across every server, and it reads Redis's own clock so servers with drifting clocks agree.
 */
import type { Redis } from "ioredis";

export type Bucket = { capacity: number; refillPerSec: number };
export type Decision = { allowed: boolean; retryAfterMs: number };

const TOKEN_BUCKET = `
local cap = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(state[1]) or cap
local ts = tonumber(state[2]) or now
tokens = math.min(cap, tokens + (now - ts) / 1000 * rate)
local allowed, retry = 0, 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  retry = math.ceil((cost - tokens) / rate * 1000)
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', now)
redis.call('PEXPIRE', KEYS[1], math.ceil(cap / rate * 1000) + 1000)
return { allowed, retry }
`;

type WithScript = Redis & {
  tokenBucket(key: string, cap: number, rate: number, cost: number): Promise<[number, number]>;
};

export class RateLimiter {
  private readonly redis: WithScript;

  constructor(
    redis: Redis,
    private readonly onError: (err: unknown) => void = () => {},
  ) {
    redis.defineCommand("tokenBucket", { numberOfKeys: 1, lua: TOKEN_BUCKET });
    this.redis = redis as WithScript;
  }

  /**
   * Takes `cost` tokens from the bucket at `key`. If Redis is unavailable this fails open:
   * for chat, staying available matters more than strict limits during an outage.
   */
  async take(key: string, bucket: Bucket, cost = 1): Promise<Decision> {
    try {
      const [allowed, retry] = await this.redis.tokenBucket(
        `rl:${key}`,
        bucket.capacity,
        bucket.refillPerSec,
        cost,
      );
      return { allowed: allowed === 1, retryAfterMs: retry };
    } catch (err) {
      this.onError(err);
      return { allowed: true, retryAfterMs: 0 };
    }
  }
}
