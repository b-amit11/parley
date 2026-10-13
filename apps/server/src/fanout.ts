/**
 * Fan-out between servers over Redis pub/sub.
 *
 * Topics: `chan:<id>` (messages, typing, read receipts) and `wsp:<id>` (presence changes).
 * Each server subscribes to a topic only while at least one of its local sockets is listening to
 * it, so traffic between servers grows with the topics actually in use. Pub/sub can drop messages;
 * clients recover through seq gap detection and `sync` (see DESIGN.md §2).
 */
import { type BusFrame, ServerFrame } from "@parley/shared";
import type { Redis } from "ioredis";

export type Listener = (frame: BusFrame) => void;

type Entry = { listeners: Set<Listener>; ready: Promise<unknown> };

export const channelTopic = (channelId: string) => `chan:${channelId}`;
export const workspaceTopic = (workspaceId: string) => `wsp:${workspaceId}`;

export class Fanout {
  private readonly sub: Redis;
  private readonly entries = new Map<string, Entry>();

  /** `redis` is used for publishing; a duplicate connection is opened for subscribing. */
  constructor(
    private readonly redis: Redis,
    private readonly onError: (err: unknown) => void = () => {},
  ) {
    this.sub = redis.duplicate();
    this.sub.on("error", onError);
    this.sub.on("message", (topic: string, payload: string) => this.deliver(topic, payload));
  }

  /** Resolves once Redis has confirmed the subscription, so no publish after this point is missed. */
  async subscribe(topic: string, listener: Listener): Promise<void> {
    let entry = this.entries.get(topic);
    if (!entry) {
      entry = { listeners: new Set(), ready: this.sub.subscribe(topic) };
      this.entries.set(topic, entry);
    }
    entry.listeners.add(listener);
    await entry.ready;
  }

  async unsubscribe(topic: string, listener: Listener): Promise<void> {
    const entry = this.entries.get(topic);
    if (!entry) return;
    entry.listeners.delete(listener);
    if (entry.listeners.size > 0) return;
    this.entries.delete(topic);
    // ioredis runs commands on a connection in order, so a later subscribe to the same topic
    // still happens after this unsubscribe.
    await this.sub.unsubscribe(topic);
  }

  async publish(topic: string, frame: BusFrame): Promise<void> {
    await this.redis.publish(topic, JSON.stringify(frame));
  }

  /** Number of topics this server is currently subscribed to (for metrics and tests). */
  get topicCount(): number {
    return this.entries.size;
  }

  async close(): Promise<void> {
    await this.sub.quit().catch(() => {});
  }

  private deliver(topic: string, payload: string): void {
    const entry = this.entries.get(topic);
    if (!entry) return;
    let frame: ServerFrame;
    try {
      frame = ServerFrame.parse(JSON.parse(payload));
    } catch (err) {
      this.onError(err);
      return;
    }
    for (const listener of entry.listeners) listener(frame as BusFrame);
  }
}
