/**
 * A channel's message history on the client, as pure functions so they're easy to test.
 *
 * `messages` is always contiguous by seq. A message that arrives ahead of a gap waits in `ahead`
 * until the missing ones arrive through sync. Messages at or below `head` are duplicates
 * (delivery is at least once) and are dropped.
 */
import type { Message } from "@parley/shared";

const MAX_HELD = 200;

export type Timeline = {
  /** Whether the latest page of history has been fetched. Until then nothing is kept. */
  loaded: boolean;
  messages: Message[];
  /** Highest seq we hold with no gaps below it (back to the oldest loaded message). */
  head: number;
  hasOlder: boolean;
  ahead: Map<number, Message>;
};

export const emptyTimeline = (): Timeline => ({
  loaded: false,
  messages: [],
  head: 0,
  hasOlder: false,
  ahead: new Map(),
});

export type Applied = {
  timeline: Timeline;
  /** Set when messages are missing after this seq and a sync should be requested. */
  gapAfter: number | null;
};

/** Applies live or synced messages. */
export function applyIncoming(t: Timeline, incoming: Message[]): Applied {
  if (!t.loaded) {
    // Not opened yet: hold recent messages so ones that arrive while the first page is loading
    // aren't lost. Capped, since a channel nobody opens shouldn't grow without limit.
    const ahead = new Map(t.ahead);
    for (const m of incoming) ahead.set(m.seq, m);
    for (const seq of [...ahead.keys()].sort((a, b) => a - b).slice(0, Math.max(0, ahead.size - MAX_HELD))) {
      ahead.delete(seq);
    }
    return { timeline: { ...t, ahead }, gapAfter: null };
  }
  const ahead = new Map(t.ahead);
  for (const m of incoming) if (m.seq > t.head) ahead.set(m.seq, m);
  const added: Message[] = [];
  let head = t.head;
  for (let next = ahead.get(head + 1); next; next = ahead.get(head + 1)) {
    added.push(next);
    ahead.delete(next.seq);
    head = next.seq;
  }
  const timeline =
    added.length || ahead.size !== t.ahead.size
      ? { ...t, messages: [...t.messages, ...added], head, ahead }
      : t;
  return { timeline, gapAfter: ahead.size ? head : null };
}

/** Applies the latest page of history (the first load of a channel). */
export function applyLatest(t: Timeline, page: Message[], hasOlder: boolean): Applied {
  const head = page.length ? page[page.length - 1]!.seq : 0;
  const base: Timeline = { loaded: true, messages: page, head, hasOlder, ahead: new Map() };
  // Anything that arrived live while the page was loading still counts.
  return applyIncoming(base, [...t.ahead.values()]);
}

/** Adds an older page in front of what's loaded (scrolling back). */
export function applyOlder(t: Timeline, page: Message[], hasOlder: boolean): Timeline {
  const oldest = t.messages[0]?.seq ?? Number.POSITIVE_INFINITY;
  const older = page.filter((m) => m.seq < oldest);
  return { ...t, messages: [...older, ...t.messages], hasOlder };
}
