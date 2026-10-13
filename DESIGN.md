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
| Scale (target for the demo) | 10k simultaneous connections across 3 servers, 1k messages/s |
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
- Each socket sends a heartbeat every 20 s. The server stores
  `presence:<userId>` as a Redis set of connection ids, each with an expiry 60 s ahead.
- A user is online if they have at least one connection that hasn't expired, which handles
  multiple tabs and devices. When a server crashes, its entries simply expire, so no cleanup job
  is needed.
- Changes from offline to online and back are published to the workspace channel.

### 5. Typing indicators
Only ever passed through pub/sub, never stored, throttled to one event every 3 s per user per
channel. Losing one is harmless.

### 6. Read receipts and unread counts
`read_cursors(user_id, channel_id, last_read_seq)`. Unread count = `channel.last_seq -
last_read_seq`, which costs nothing because no messages have to be counted.

### 7. Backpressure and abuse
- Rate limits use a token bucket in Redis per user (a Lua script, so it's atomic across servers).
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
| A server crashes | Its clients disconnect | Clients reconnect with backoff and jitter, then sync from their last `seq` |
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
1. **Server core:** auth, workspaces and channels, WebSocket gateway, ordered and duplicate-safe
   sends, Redis fan-out, sync, multi-server integration tests. ← *current*
2. Online status, typing indicators, read receipts and unread counts, rate limiting, backpressure.
3. React web client (channel list, message list with unsent/pending messages shown, reconnecting,
   online indicators).
4. Docker Compose with 3 servers behind nginx, the load test, metrics (Prometheus) and a
   deployment.
