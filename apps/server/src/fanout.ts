/**
 * Fan-out between servers over Redis pub/sub.
 *
 * Each server subscribes to `chan:<id>` only while at least one of its local sockets is
 * listening to that channel, so traffic between servers grows with the channels actually in use.
 * Pub/sub can drop messages; clients recover through seq gap detection and `sync`
 * (see DESIGN.md §2).
 */
import { type Message, Message as MessageSchema } from "@parley/shared";
import { Redis } from "ioredis";

export type Listener = (message: Message) => void;

type Entry = { listeners: Set<Listener>; ready: Promise<unknown> };

const key = (channelId: string) => `chan:${channelId}`;

export class Fanout {
  private readonly pub: Redis;
  private readonly sub: Redis;
  private readonly entries = new Map<string, Entry>();

  constructor(
    url: string,
    private readonly onError: (err: unknown) => void = () => {},
  ) {
    this.pub = new Redis(url, { maxRetriesPerRequest: 2 });
    this.sub = new Redis(url);
    this.pub.on("error", onError);
    this.sub.on("error", onError);
    this.sub.on("message", (channel: string, payload: string) => this.deliver(channel, payload));
  }

  /** Resolves once Redis has confirmed the subscription, so no publish after this point is missed. */
  async subscribe(channelId: string, listener: Listener): Promise<void> {
    let entry = this.entries.get(channelId);
    if (!entry) {
      entry = { listeners: new Set(), ready: this.sub.subscribe(key(channelId)) };
      this.entries.set(channelId, entry);
    }
    entry.listeners.add(listener);
    await entry.ready;
  }

  async unsubscribe(channelId: string, listener: Listener): Promise<void> {
    const entry = this.entries.get(channelId);
    if (!entry) return;
    entry.listeners.delete(listener);
    if (entry.listeners.size > 0) return;
    this.entries.delete(channelId);
    // ioredis runs commands on a connection in order, so a later subscribe to the same channel
    // still happens after this unsubscribe.
    await this.sub.unsubscribe(key(channelId));
  }

  async publish(message: Message): Promise<void> {
    await this.pub.publish(key(message.channelId), JSON.stringify(message));
  }

  /** Number of channels this server is currently subscribed to (for metrics and tests). */
  get channelCount(): number {
    return this.entries.size;
  }

  async ping(): Promise<boolean> {
    return (await this.pub.ping()) === "PONG";
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.pub.quit(), this.sub.quit()]);
  }

  private deliver(channel: string, payload: string): void {
    const entry = this.entries.get(channel.slice("chan:".length));
    if (!entry) return;
    let message: Message;
    try {
      message = MessageSchema.parse(JSON.parse(payload));
    } catch (err) {
      this.onError(err);
      return;
    }
    for (const listener of entry.listeners) listener(message);
  }
}
