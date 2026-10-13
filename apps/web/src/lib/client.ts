/**
 * The client side of parley's delivery guarantees (DESIGN.md §2), independent of any UI framework.
 *
 * - Sending: a message shows immediately as "pending" with a clientMsgId, and is resent with the
 *   same id after any reconnect until acked. The server deduplicates, so a resend is harmless.
 * - Receiving: messages are deduplicated and ordered by seq. A gap triggers a `sync`.
 * - Reconnecting: exponential backoff with jitter, then resubscribe, sync each open channel from
 *   its head, and resend everything still pending.
 *
 * State is immutable and exposed through subscribe/getState, so React can use
 * useSyncExternalStore directly.
 */
import { type ClientFrame, type Message, PROTOCOL, ServerFrame } from "@parley/shared";
import type { Api, ChannelSummary, Member, User } from "./api.ts";
import { applyIncoming, applyLatest, applyOlder, emptyTimeline, type Timeline } from "./timeline.ts";

export type ConnectionStatus = "connecting" | "online" | "offline";

export type PendingMessage = {
  clientMsgId: string;
  channelId: string;
  body: string;
  status: "sending" | "failed";
  error?: string;
  createdAt: number;
};

export type ChannelState = ChannelSummary & { timeline: Timeline };

export type ClientState = {
  status: ConnectionStatus;
  channels: Record<string, ChannelState>;
  members: Record<string, Member>;
  pending: PendingMessage[];
  /** channelId → userId → when the indicator expires (ms since epoch). */
  typing: Record<string, Record<string, number>>;
  online: ReadonlySet<string>;
  /** channelId → userId → last read seq, for "seen by". */
  reads: Record<string, Record<string, number>>;
};

export type ClientOptions = {
  api: Api;
  wsUrl: string;
  token: string;
  me: User;
  workspaceId: string;
  WebSocket?: typeof WebSocket;
  backoff?: { minMs: number; maxMs: number };
  /** How often to re-fetch the channel list, to notice channels you were added to. */
  refreshMs?: number;
};

const TYPING_SHOWN_MS = 4000;
const PING_MS = 25_000;
const SUBSCRIBE_CHUNK = 500;

type Listener = () => void;

export class ChatClient {
  private state: ClientState = {
    status: "connecting",
    channels: {},
    members: {},
    pending: [],
    typing: {},
    online: new Set(),
    reads: {},
  };
  private readonly listeners = new Set<Listener>();
  private ws: WebSocket | null = null;
  private attempt = 0;
  private stopped = false;
  /** Bumped by start/stop, so a start() still awaiting its first fetch can tell it was cancelled. */
  private generation = 0;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private intervals: ReturnType<typeof setInterval>[] = [];
  private readonly WS: typeof WebSocket;

  constructor(private readonly opts: ClientOptions) {
    this.WS = opts.WebSocket ?? globalThis.WebSocket;
  }

  // ── store ─────────────────────────────────────────────────────────────────

  getState = (): ClientState => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<ClientState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  private updateChannel(id: string, fn: (c: ChannelState) => ChannelState): void {
    const current = this.state.channels[id];
    if (!current) return;
    const next = fn(current);
    if (next !== current) this.set({ channels: { ...this.state.channels, [id]: next } });
  }

  get me(): User {
    return this.opts.me;
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    const generation = ++this.generation;
    this.stopped = false;
    await Promise.all([this.refreshChannels(), this.refreshMembers()]);
    if (generation !== this.generation) return; // stopped (or restarted) while loading
    this.connect();
    this.intervals.push(
      setInterval(() => this.send({ type: "ping" }), PING_MS),
      setInterval(() => this.expireTyping(), 1000),
      setInterval(() => void this.refreshChannels().catch(() => {}), this.opts.refreshMs ?? 30_000),
    );
  }

  stop(): void {
    this.generation++;
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    for (const i of this.intervals) clearInterval(i);
    this.intervals = [];
    this.ws?.close(1000);
    this.ws = null;
  }

  /** Simulates a dropped network connection (used by tests and the demo's "go offline" button). */
  dropConnection(): void {
    this.ws?.close(4000, "dropped");
  }

  private later(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  private connect(): void {
    if (this.stopped) return;
    this.set({ status: this.attempt === 0 ? "connecting" : "offline" });
    const ws = new this.WS(this.opts.wsUrl, [PROTOCOL, `token.${this.opts.token}`]);
    this.ws = ws;
    ws.onmessage = (event) => this.onFrame(String(event.data));
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.stopped) return;
      this.set({ status: "offline" });
      const { minMs, maxMs } = this.opts.backoff ?? { minMs: 500, maxMs: 30_000 };
      // Jitter spreads reconnects out, so a server restart doesn't bring every client back at once.
      const delay = Math.min(maxMs, minMs * 2 ** this.attempt) * (0.5 + Math.random() * 0.5);
      this.attempt++;
      this.later(delay, () => this.connect());
    };
  }

  private send(frame: ClientFrame): boolean {
    if (this.ws?.readyState !== this.WS.OPEN) return false;
    this.ws.send(JSON.stringify(frame));
    return true;
  }

  /** After (re)connecting: subscribe, catch up, and resend anything still pending. */
  private onReady(): void {
    this.attempt = 0;
    this.set({ status: "online" });
    const joined = Object.values(this.state.channels).filter((c) => c.joined);
    for (let i = 0; i < joined.length; i += SUBSCRIBE_CHUNK) {
      this.send({ type: "subscribe", channelIds: joined.slice(i, i + SUBSCRIBE_CHUNK).map((c) => c.id) });
    }
    this.send({ type: "watch_presence", workspaceId: this.opts.workspaceId });
    // Frames are handled in order on the server, so these syncs run after the subscriptions:
    // nothing published in between is missed.
    for (const c of joined) {
      if (c.timeline.loaded) this.send({ type: "sync", channelId: c.id, afterSeq: c.timeline.head });
    }
    for (const p of this.state.pending) {
      if (p.status === "sending") this.sendPending(p);
    }
    // Unread counts for channels that aren't loaded may have changed while we were away.
    void this.refreshChannels().catch(() => {});
  }

  // ── incoming frames ───────────────────────────────────────────────────────

  private onFrame(raw: string): void {
    const parsed = ServerFrame.safeParse(JSON.parse(raw));
    if (!parsed.success) return;
    const frame = parsed.data;
    switch (frame.type) {
      case "ready":
        return this.onReady();
      case "ack":
        this.set({ pending: this.state.pending.filter((p) => p.clientMsgId !== frame.clientMsgId) });
        return this.receive([frame.message]);
      case "message":
        this.clearTyping(frame.message.channelId, frame.message.senderId);
        return this.receive([frame.message]);
      case "sync_result": {
        this.receive(frame.messages);
        const head = this.state.channels[frame.channelId]?.timeline.head;
        if (frame.hasMore && head !== undefined)
          this.send({ type: "sync", channelId: frame.channelId, afterSeq: head });
        return;
      }
      case "typing":
        return this.set({
          typing: {
            ...this.state.typing,
            [frame.channelId]: {
              ...this.state.typing[frame.channelId],
              [frame.userId]: Date.now() + TYPING_SHOWN_MS,
            },
          },
        });
      case "read":
        this.set({
          reads: {
            ...this.state.reads,
            [frame.channelId]: { ...this.state.reads[frame.channelId], [frame.userId]: frame.seq },
          },
        });
        if (frame.userId === this.me.id) {
          this.updateChannel(frame.channelId, (c) =>
            frame.seq > c.lastReadSeq ? { ...c, lastReadSeq: frame.seq } : c,
          );
        }
        return;
      case "presence_snapshot":
        return this.set({ online: new Set(frame.online) });
      case "presence": {
        const online = new Set(this.state.online);
        if (frame.online) online.add(frame.userId);
        else online.delete(frame.userId);
        return this.set({ online });
      }
      case "error":
        return this.onError(frame);
      default:
        return;
    }
  }

  private receive(messages: Message[]): void {
    const byChannel = new Map<string, Message[]>();
    for (const m of messages) byChannel.set(m.channelId, [...(byChannel.get(m.channelId) ?? []), m]);
    for (const [channelId, msgs] of byChannel) {
      let gap: number | null = null;
      this.updateChannel(channelId, (c) => {
        const { timeline, gapAfter } = applyIncoming(c.timeline, msgs);
        gap = gapAfter;
        const lastSeq = Math.max(c.lastSeq, ...msgs.map((m) => m.seq));
        const mine = msgs.filter((m) => m.senderId === this.me.id).map((m) => m.seq);
        const lastReadSeq = Math.max(c.lastReadSeq, ...mine);
        return timeline === c.timeline && lastSeq === c.lastSeq && lastReadSeq === c.lastReadSeq
          ? c
          : { ...c, timeline, lastSeq, lastReadSeq, unread: lastSeq - lastReadSeq };
      });
      if (gap !== null) this.send({ type: "sync", channelId, afterSeq: gap });
    }
  }

  private onError(frame: Extract<ServerFrame, { type: "error" }>): void {
    const pending = this.state.pending.find((p) => p.clientMsgId === frame.ref);
    if (!pending) return;
    if (frame.code === "rate_limited") {
      // Still "sending": try again once the server says there's capacity.
      this.later(frame.retryAfterMs ?? 1000, () => {
        const still = this.state.pending.find((p) => p.clientMsgId === pending.clientMsgId);
        if (still?.status === "sending") this.sendPending(still);
      });
      return;
    }
    this.setPending(pending.clientMsgId, { status: "failed", error: frame.message });
  }

  private clearTyping(channelId: string, userId: string): void {
    const forChannel = this.state.typing[channelId];
    if (!forChannel?.[userId]) return;
    const { [userId]: _, ...rest } = forChannel;
    this.set({ typing: { ...this.state.typing, [channelId]: rest } });
  }

  private expireTyping(): void {
    const now = Date.now();
    let changed = false;
    const typing: ClientState["typing"] = {};
    for (const [channelId, users] of Object.entries(this.state.typing)) {
      const live = Object.fromEntries(Object.entries(users).filter(([, until]) => until > now));
      if (Object.keys(live).length !== Object.keys(users).length) changed = true;
      typing[channelId] = live;
    }
    if (changed) this.set({ typing });
  }

  // ── actions ───────────────────────────────────────────────────────────────

  async refreshChannels(): Promise<void> {
    const { channels } = await this.opts.api.channels(this.opts.workspaceId);
    const next: Record<string, ChannelState> = {};
    const newlyJoined: string[] = [];
    for (const summary of channels) {
      const existing = this.state.channels[summary.id];
      if (summary.joined && !existing?.joined) newlyJoined.push(summary.id);
      next[summary.id] = existing
        ? {
            ...existing,
            ...summary,
            // Live state can be newer than the HTTP snapshot; never move backwards.
            lastSeq: Math.max(existing.lastSeq, summary.lastSeq),
            lastReadSeq: Math.max(existing.lastReadSeq, summary.lastReadSeq),
            unread:
              Math.max(existing.lastSeq, summary.lastSeq) -
              Math.max(existing.lastReadSeq, summary.lastReadSeq),
          }
        : { ...summary, timeline: emptyTimeline() };
    }
    this.set({ channels: next });
    if (newlyJoined.length && this.state.status === "online") {
      this.send({ type: "subscribe", channelIds: newlyJoined });
    }
  }

  async refreshMembers(): Promise<void> {
    const { members } = await this.opts.api.members(this.opts.workspaceId);
    this.set({ members: Object.fromEntries(members.map((m) => [m.id, m])) });
  }

  /** Loads a channel's latest messages the first time it's opened. */
  async open(channelId: string): Promise<void> {
    const channel = this.state.channels[channelId];
    if (!channel?.joined || channel.timeline.loaded) return;
    const page = await this.opts.api.history(channelId);
    let gap: number | null = null;
    this.updateChannel(channelId, (c) => {
      const applied = applyLatest(c.timeline, page.messages, page.hasMore);
      gap = applied.gapAfter;
      return { ...c, timeline: applied.timeline };
    });
    if (gap !== null) this.send({ type: "sync", channelId, afterSeq: gap });
    void this.opts.api.reads(channelId).then(({ reads }) =>
      this.set({
        reads: {
          ...this.state.reads,
          [channelId]: Object.fromEntries(reads.map((r) => [r.userId, r.lastReadSeq])),
        },
      }),
    );
  }

  async loadOlder(channelId: string): Promise<void> {
    const t = this.state.channels[channelId]?.timeline;
    const oldest = t?.messages[0]?.seq;
    if (!t?.hasOlder || oldest === undefined) return;
    const page = await this.opts.api.history(channelId, oldest);
    this.updateChannel(channelId, (c) => ({
      ...c,
      timeline: applyOlder(c.timeline, page.messages, page.hasMore),
    }));
  }

  async join(channelId: string): Promise<void> {
    await this.opts.api.join(channelId);
    await this.refreshChannels();
  }

  sendMessage(channelId: string, body: string): PendingMessage {
    const pending: PendingMessage = {
      clientMsgId: crypto.randomUUID(),
      channelId,
      body,
      status: "sending",
      createdAt: Date.now(),
    };
    this.set({ pending: [...this.state.pending, pending] });
    this.sendPending(pending); // if offline, it goes out on reconnect
    return pending;
  }

  retry(clientMsgId: string): void {
    const p = this.state.pending.find((x) => x.clientMsgId === clientMsgId);
    if (!p) return;
    this.setPending(clientMsgId, { status: "sending", error: undefined });
    this.sendPending({ ...p, status: "sending" });
  }

  discard(clientMsgId: string): void {
    this.set({ pending: this.state.pending.filter((p) => p.clientMsgId !== clientMsgId) });
  }

  typing(channelId: string): void {
    this.send({ type: "typing", channelId });
  }

  /** Marks everything loaded in a channel as read. */
  markRead(channelId: string): void {
    const c = this.state.channels[channelId];
    if (!c?.joined) return;
    const seq = Math.max(c.timeline.head, c.timeline.loaded ? 0 : c.lastSeq);
    if (seq <= c.lastReadSeq) return;
    this.updateChannel(channelId, (ch) => ({
      ...ch,
      lastReadSeq: seq,
      unread: Math.max(0, ch.lastSeq - seq),
    }));
    this.send({ type: "read", channelId, seq });
  }

  private sendPending(p: PendingMessage): void {
    this.send({ type: "send", channelId: p.channelId, clientMsgId: p.clientMsgId, body: p.body });
  }

  private setPending(clientMsgId: string, patch: Partial<PendingMessage>): void {
    this.set({
      pending: this.state.pending.map((p) => (p.clientMsgId === clientMsgId ? { ...p, ...patch } : p)),
    });
  }
}
