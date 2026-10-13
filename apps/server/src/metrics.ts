/**
 * Prometheus metrics, served at GET /metrics on each server (not exposed through the load balancer).
 * Module-level, so several servers running in one test process share one registry.
 */
import client from "prom-client";

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: "parley_" });

const registers = [registry];

export const metrics = {
  connections: new client.Gauge({
    name: "parley_ws_connections",
    help: "Open WebSocket connections on this server",
    registers,
  }),
  frames: new client.Counter({
    name: "parley_ws_frames_total",
    help: "Frames received from clients, by type",
    labelNames: ["type"] as const,
    registers,
  }),
  messages: new client.Counter({
    name: "parley_messages_total",
    help: "Messages stored (outcome: new, duplicate, or rejected)",
    labelNames: ["outcome"] as const,
    registers,
  }),
  sendSeconds: new client.Histogram({
    name: "parley_send_duration_seconds",
    help: "Time to rate-limit, store and acknowledge a send",
    buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
    registers,
  }),
  rateLimited: new client.Counter({
    name: "parley_rate_limited_total",
    help: "Requests refused by a rate limit",
    labelNames: ["action"] as const,
    registers,
  }),
  publishFailures: new client.Counter({
    name: "parley_fanout_publish_failures_total",
    help: "Redis publishes that failed (clients recover through sync)",
    registers,
  }),
  slowClients: new client.Counter({
    name: "parley_slow_client_disconnects_total",
    help: "Sockets closed because their send buffer was over the limit",
    registers,
  }),
  presenceSwept: new client.Counter({
    name: "parley_presence_swept_total",
    help: "Users marked offline by the sweep because all their connections expired",
    registers,
  }),
};
