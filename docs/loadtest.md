# Load and chaos testing

All numbers come from [`apps/loadtest`](../apps/loadtest/src/main.ts), and the raw results are
the JSON files in [`docs/loadtest/`](loadtest/).

## Method

- **Real clients.** Every simulated user is an instance of the same `ChatClient` the browser runs:
  messages waiting to send, reconnecting with backoff and jitter, catching up when a gap appears.
  Nothing is cut short for speed.
- **Topology.** Three parley servers behind nginx (`least_conn`), plus Postgres 17 and Redis 7, all
  in Docker Compose (`npm run cluster:up`).
- **Workload.** `channels × members` users. Each channel is a separate workspace, and each user sends
  messages at random intervals (exponential gaps, so arrivals are random as in real traffic rather
  than in lockstep) at `rate` messages per second. Every message reaches the other 19 members of its
  channel.
- **Latency.** Each message carries its send timestamp. *Ack* is the time until the sender gets the
  server's confirmation. *Delivery* is the time until another member receives the message live.
  Generator and servers run on the same machine, so they share one clock.
- **Correctness check after every run.** Every client's timeline is compared with Postgres. Each
  client must hold every message in its channel exactly once and in seq order, with nothing left
  unacknowledged and no seq gaps in the database. A run fails if any check fails.

**Hardware:** one Apple M3 Pro laptop (11 cores) runs everything: the servers, Postgres, Redis,
nginx, Prometheus *and* the load generator, inside the Docker Desktop VM. That means the generator
competes with the system for CPU. These are single-machine numbers, not a production capacity plan.

## Results

| Run | Connections | Sends/s | Deliveries/s | Delivery p50 / p95 / p99 / max | Correct |
|---|---:|---:|---:|---|:-:|
| [steady](loadtest/steady-2000-in-network.json) | 2,000 | 1,017 | 19,328 | 1 / 3 / **5** / 102 ms | ✅ |
| [steady (heavier)](loadtest/steady-4000-in-network.json) | 4,000 | 2,021 | 38,403 | 2 / 69 / 161 / 351 ms | ✅ |
| [crash test](loadtest/chaos-1000-failover.json): one server SIGKILLed at 30 s, restarted at 41 s | 1,000 | 506 | 9,607 | 2 / 4 / **135** / 1,463 ms | ✅ |

In every run, every client ended with every message exactly once, in order. In the crash test,
330 clients lost their server. They reconnected to the other two within about a second, and the
3,601 messages sent while they were reconnecting arrived through catch-up (`sync`). On the server
side, storing and acknowledging a send took **1.6 ms at p50 and 26.6 ms at p99** (Prometheus,
`parley_send_duration_seconds`).

**Where it bends:** at 2,000 sends/s (38k deliveries/s) the median is still 2 ms, but the tail
grows. The load generator's own event-loop lag reached 37 ms at p99 there, so part of that tail is
the generator sharing CPU with the system it's measuring.

## Two things the load test caught

### 1. Failover took 11 seconds instead of 1

The first crash run passed the correctness checks, but p99 delivery was **10.9 s**. The
disconnected clients only came back once the killed server restarted.
([before](loadtest/chaos-1000.json))

The cause was two nginx defaults working together:
- A SIGKILLed container's IP doesn't *refuse* connections, it *times out*, and nginx's
  default `proxy_connect_timeout` is **60 s**.
- `least_conn` sends new connections to the server with the fewest open ones, which is the dead
  server, because it has none.

The fix: `proxy_connect_timeout 1s` plus `proxy_next_upstream error timeout`, so a reconnect that
hits the dead server is retried on a healthy one within the same request.

| Crash test | p99 delivery | Max delivery | Recovered through catch-up |
|---|---:|---:|---:|
| Before | 10,902 ms | 13,068 ms | 28,046 |
| After | **135 ms** | **1,463 ms** | 3,601 |

### 2. Most of the measured tail latency came from Docker Desktop, not parley

With the generator running on macOS and connecting through Docker Desktop's port forwarding,
2,000 connections at 1,000 sends/s showed **p99 264 ms**
([run](loadtest/steady-2000.json)), even though the servers reported only 26.6 ms p99 per send.
Splitting the generator into two processes made it *worse*
([a](loadtest/split-a.json), [b](loadtest/split-b.json)), which ruled out the generator. Running
the generator *inside* the Docker network removed the port forwarding from the path, and the same
load gave **p99 5 ms**. The in-network runs are the representative numbers above; the earlier runs
are kept for comparison.

## Reproduce

```bash
npm run cluster:up
docker compose run --rm loadtest --channels 100 --members 20 --rate 0.5 --duration 60   # in-network
npm run loadtest -- --channels 50 --members 20 --rate 0.5 --duration 60 --chaos            # crash test (from the host)
```
Grafana-ready metrics are on Prometheus at http://localhost:9090
(for example `histogram_quantile(0.99, sum by (le) (rate(parley_send_duration_seconds_bucket[1m])))`).
