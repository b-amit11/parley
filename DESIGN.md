# parley: design

parley is a real-time chat platform (workspaces, channels, direct messages, online status, typing
indicators, read receipts) built to run as several identical servers behind a load balancer.

## Requirements

**Functional**
- Sign up and log in; create workspaces; invite members.
- Public and private channels, plus direct messages (a DM is a private channel with two members).
- Send and receive messages in real time; scroll back through history.
- Online status, typing indicators, unread counts and read receipts.

**Non-functional**
| Property | Target |
|---|---|
| Message delivery | Every message that gets an ack is stored, and reaches every online member once their connection is healthy |
| Ordering | One total order per channel, the same for every client |
| Duplicates | A retried send never creates a second message |
| Latency | p99 under 150 ms from send to delivery, on a single region |
| Scale (target for the demo) | 10k simultaneous connections across 3 servers, 1k messages/s; **measured:** 1,017 msgs/s (19k deliveries/s) with p99 of 5 ms at 2k connections, see [docs/loadtest.md](docs/loadtest.md) |
| Availability | Losing one server only disconnects its clients; they reconnect elsewhere and catch up |

## Architecture

```
 clients (web)  ──WebSocket + HTTPS──▶  load balancer (no sticky sessions needed)
                                          │          │          │
                                      server-1   server-2   server-3     (stateless Node)
                                          │  ▲       │  ▲       │  ▲
                              SQL write   │  └── Redis pub/sub ─┘  │  fan-out between servers
                                          ▼                        ▼
                                     Postgres                 Redis
                       (source of truth: users, channels,  (presence, typing, rate limits,
                        messages, read cursors)              pub/sub; nothing permanent)
```

Servers keep no state that matters: any client can connect to any server. Each server keeps only
its open sockets and which channels each socket is subscribed to.

## Key decisions

### 1. Ordering: a sequence number per channel, assigned by Postgres
Each channel row has `last_seq`. Sending a message runs one transaction:
```sql
UPDATE channels SET last_seq = last_seq + 1 WHERE id = $1 RETURNING last_seq;
INSERT INTO messages (channel_id, seq, ...) VALUES ($1, <last_seq>, ...);
```
The row lock serializes writes **per channel**, so every client sees the same order, gaps are
easy to detect, and fetching "everything after seq N" is a single index range scan on
`(channel_id, seq)`.
*Trade-off:* a very busy channel is limited by that one row lock (roughly a few thousand writes per
second). That's plenty for chat. Higher volumes would need a sequencer for each channel shard,
or Snowflake-style IDs with relaxed ordering.

### 2. Delivery: at least once, with duplicates removed by the client
- The client creates a `clientMsgId` (a UUID) for each send and retries until it gets an ack.
  A unique key on `(sender_id, client_msg_id)` makes retries harmless: a retry gets the original
  message back.
- After saving, the server publishes the message to Redis (`chan:<id>`). Every server
  subscribed to that channel pushes it to its local sockets.
- Redis pub/sub is **fire-and-forget**: if a server misses a publish, its clients would miss
  the message. So pub/sub is only the *fast path*. The *source of truth* is Postgres, plus each
  client tracking its position:
  - The client stores the last `seq` it has seen for each channel.
  - If it gets `seq > last + 1`, it has missed something, so it asks `sync {channelId, afterSeq}`.
  - After reconnecting, it syncs every channel it has open.
- Result: a message can arrive twice (live, and again in a sync), and the client drops repeats by
  `seq`. No message is lost while Postgres is up.

*Alternative considered:* Redis Streams or Kafka, with a consumer group for each server. They
give a log that can be replayed, but add operational weight. Since Postgres already holds the
ordered log, gap detection plus sync gives the same guarantee more cheaply.

### 3. Fan-out between servers
Each server subscribes to `chan:<id>` in Redis only while at least one of its local sockets cares
about that channel (counted per channel), and unsubscribes when the count drops to zero. So
traffic between servers grows with the channels actually in use, not with every channel.

### 4. Presence
Two Redis sorted sets, both scored by expiry time and only changed through Lua scripts (atomic,
using Redis's own clock so servers whose clocks drift still agree):
- `presence:conns:<userId>`: that user's connection ids. Several tabs or devices count as one
  online user.
- `presence:online`: user ids, scored by their latest connection expiry.

| Event | What happens | Announced by |
|---|---|---|
| Socket opens | `touch` adds the connection; returns "just came online" if the user wasn't live | the server that took the connection |
| Every 20 s | each server touches *its own* connections in one pipeline | (no change, so no event) |
| Socket closes | `drop` removes it; returns "went offline" only if it was the last live connection | that server |
| A server crashes | its connections stop being refreshed and expire after 60 s | **the sweep** |

The sweep runs on every server every 10 s. One script atomically removes users whose connections
have all expired and returns them, so exactly one server sees each user and announces them
offline. There's no leader election and no duplicate events.

Online/offline changes are published to `wsp:<workspaceId>` for every workspace the user is in.
`watch_presence` subscribes *first* and then takes the snapshot (`ZSCORE > now` for each member),
so no change between the two is missed.

### 5. Typing indicators
Only ever passed through pub/sub, never stored. The server throttles them to one every 2 s per
connection per channel. That's done in memory: a user with two tabs could send two, which is
harmless, and it saves a Redis round trip on the busiest event in the system. The sender's own
servers don't echo the indicator back to them. Clients must be subscribed to the channel, so
checking membership costs nothing.

### 6. Read receipts and unread counts
`read_cursors(user_id, channel_id, last_read_seq)`. Unread count = `channel.last_seq -
last_read_seq`, which costs nothing because no messages have to be counted.
- `read` only ever moves forward (an upsert with `WHERE old < new`), capped at `last_seq`. When the
  cursor actually advances, a `read` event is published for "seen by" indicators.
- Sending a message moves the sender's own cursor forward in the same transaction.

### 7. Backpressure and abuse
- Rate limits use a token bucket in Redis (a Lua script, so it's atomic across servers):
  sends per user (20 burst, 5/s), and failed logins per username (10 burst, 1 every 30 s) to
  slow password guessing whatever IP it comes from.
  If Redis is down the limiter **fails open**: for chat, staying available during an outage
  matters more than strict limits.
- If a socket's send buffer goes over a limit (a slow client), the server closes it with a
  "please resync" code instead of buffering without limit.
- Maximum message size, and every incoming frame is validated against the shared message schemas.

### 8. Authentication
Passwords are hashed with scrypt. Sessions use random tokens, stored only as hashes and able to be
revoked, chosen over JWTs because they can be revoked instantly. The WebSocket connection
authenticates with the same token during the first handshake.

## Protocol (WebSocket, JSON)
Messages from client to server and back are defined once in `packages/shared` using zod schemas,
and checked on both sides.

```
client → server: send, sync, subscribe, unsubscribe, typing, read, ping
server → client: ack, message, sync_result, presence, typing, read, error, pong
```

## Data model
```
users(id, username UNIQUE, password_hash, created_at)
sessions(token_hash PK, user_id, expires_at)
workspaces(id, name, created_by)
workspace_members(workspace_id, user_id, role)
channels(id, workspace_id, name, kind[public|private|dm], last_seq)
channel_members(channel_id, user_id)
messages(id, channel_id, seq, sender_id, client_msg_id, body, created_at)
   UNIQUE(channel_id, seq), UNIQUE(sender_id, client_msg_id)
read_cursors(user_id, channel_id, last_read_seq)
```

## Failure modes
| Failure | Effect | Recovery |
|---|---|---|
| A server crashes | Its clients disconnect | Clients reconnect with backoff and jitter; nginx fails over within 1 s (`proxy_connect_timeout 1s` + `proxy_next_upstream`); clients sync from their last `seq`. Measured: 0 messages lost, p99 135 ms |
| Redis drops a publish | Some clients miss a live message | Detected as a gap in `seq` (or on the next message), then a sync |
| Redis is down | No live fan-out, no presence | Messages still save; clients poll `sync`; the server reports itself degraded |
| Postgres is down | Sends fail without an ack | The client keeps the unsent message and retries with the same `clientMsgId` |
| Slow client | Its send buffer fills up | Disconnected with a resync code, so it can't hurt other clients |

## Testing
- Unit tests for the protocol schemas, rate limiter and sequencing logic.
- **Integration tests against real Postgres and Redis, with two server instances**, proving that
  messages reach clients on the other server, the order is the same everywhere, retries don't
  duplicate, catch-up works after reconnecting, and online status expires.
- A load test script (many WebSocket clients) reporting p50/p99 delivery latency and messages per
  second, with results in the README.

## Milestones
1. ✅ **Server core:** auth, workspaces and channels, WebSocket gateway, ordered and duplicate-safe
   sends, Redis fan-out, sync, multi-server integration tests.
2. ✅ **Live features:** online status (crash-safe sweep), typing indicators, read receipts and
   unread counts, rate limiting.
3. ✅ **React web client:** a framework-independent `ChatClient` engine (pending messages,
   reconnect with backoff and jitter, gap-driven sync, deduplication by seq) tested against two
   real servers, plus the React UI.
4. ✅ **Running it:** 3 servers behind nginx (`least_conn`, fast failover), Prometheus metrics, a
   load and crash test built on the real client engine that checks correctness after every run.
