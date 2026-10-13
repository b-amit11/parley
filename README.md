# parley

A real-time chat platform (workspaces, channels, DMs) designed to run as several identical servers
behind a load balancer, without losing, duplicating or reordering messages.

**[Design doc →](DESIGN.md)** covers requirements, architecture, trade-offs and failure modes.

## What makes it interesting

- **One order per channel, everywhere.** Postgres hands out a sequence number per channel inside the
  send transaction (the row lock serializes writes to that channel). Every client on every server
  sees the same order, with no gaps.
- **Retries are harmless.** Clients send a `clientMsgId`; a unique key turns any retry, even racing
  on two servers at once, into the original message. A race that loses rolls back, so its sequence
  increment is undone too and seq values stay contiguous.
- **No message is lost, even though Redis pub/sub can drop some.** Pub/sub is just the fast path
  between servers. Clients track the last `seq` they've seen, notice gaps, and `sync` from
  Postgres, the source of truth.
- **Servers keep no session state.** Any client can connect to any server. Each server
  subscribes to a Redis channel only while one of its own sockets needs it.
- **Protected against overload.** Frames from one socket are processed in order with a limit on
  how many can wait, slow clients are disconnected before they can exhaust memory, and every
  frame is validated against shared zod schemas.

```
clients ──WebSocket──▶ load balancer ──▶ server-1 · server-2 · server-3 (stateless Node)
                                               │  Redis pub/sub fan-out   │
                                               ▼                          ▼
                                           Postgres                     Redis
```

## Tested across servers, against real infrastructure

The integration tests start **two server instances** against real Postgres and Redis and check:
- delivery to a client connected to the other server;
- one identical, gapless order with three concurrent senders split across both servers, and each
  sender's messages kept in the order they sent them;
- retries racing on two servers producing exactly one message, with no gap in seq;
- catching up after reconnecting to a *different* server;
- non-members can't subscribe, send, sync or read history;
- malformed frames get an error without closing the socket; unauthenticated sockets get a 401;
- servers unsubscribe from Redis when their last local listener leaves.

## Run it

```bash
npm install
npm run db:up        # Postgres and Redis in Docker
npm test             # 20 integration tests
npm run dev          # server on :3000 (runs migrations on start)
```

Stack: TypeScript, Node 24, Fastify, ws, Postgres 17, Redis 7, zod, Vitest, Biome.

## Roadmap
1. ✅ Server core: auth, workspaces/channels/DMs, ordered and duplicate-safe sends, fan-out across servers, sync
2. Online status, typing indicators, read receipts and unread counts, rate limiting
3. React web client with sends shown before they're confirmed and automatic reconnect plus sync
4. Docker Compose with 3 servers behind nginx, a load test (p50/p99 latency, msgs/s), metrics, deployment
