import type { Message } from "@parley/shared";
import { describe, expect, it } from "vitest";
import { applyIncoming, applyLatest, applyOlder, emptyTimeline } from "../src/lib/timeline.ts";

const msg = (seq: number): Message => ({
  id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
  channelId: "11111111-1111-4111-8111-111111111111",
  seq,
  senderId: "22222222-2222-4222-8222-222222222222",
  body: `m${seq}`,
  createdAt: "2026-10-13T00:00:00.000Z",
});
const seqs = (t: { messages: Message[] }) => t.messages.map((m) => m.seq);

describe("timeline", () => {
  it("appends in order and drops duplicates", () => {
    let { timeline } = applyLatest(emptyTimeline(), [msg(1), msg(2)], false);
    ({ timeline } = applyIncoming(timeline, [msg(3), msg(2), msg(3)]));
    expect(seqs(timeline)).toEqual([1, 2, 3]);
    expect(timeline.head).toBe(3);
  });

  it("holds messages that arrive ahead of a gap and reports where the gap is", () => {
    const loaded = applyLatest(emptyTimeline(), [msg(1)], false).timeline;
    const gapped = applyIncoming(loaded, [msg(4), msg(3)]);
    expect(seqs(gapped.timeline)).toEqual([1]);
    expect(gapped.gapAfter).toBe(1);

    const filled = applyIncoming(gapped.timeline, [msg(2)]);
    expect(seqs(filled.timeline)).toEqual([1, 2, 3, 4]);
    expect(filled.gapAfter).toBeNull();
    expect(filled.timeline.ahead.size).toBe(0);
  });

  it("keeps messages that arrived live while the first page was loading", () => {
    const live = applyIncoming(emptyTimeline(), [msg(6)]).timeline;
    expect(live.loaded).toBe(false);
    const { timeline, gapAfter } = applyLatest(live, [msg(4), msg(5)], true);
    expect(seqs(timeline)).toEqual([4, 5, 6]);
    expect(gapAfter).toBeNull();
    expect(timeline.hasOlder).toBe(true);
  });

  it("caps how much it holds for channels that are never opened", () => {
    const many = Array.from({ length: 500 }, (_, i) => msg(i + 1));
    const t = applyIncoming(emptyTimeline(), many).timeline;
    expect(t.ahead.size).toBe(200);
    expect(Math.min(...t.ahead.keys())).toBe(301);
  });

  it("prepends older pages without duplicating", () => {
    const t = applyLatest(emptyTimeline(), [msg(3), msg(4)], true).timeline;
    const older = applyOlder(t, [msg(1), msg(2), msg(3)], false);
    expect(seqs(older)).toEqual([1, 2, 3, 4]);
    expect(older.hasOlder).toBe(false);
  });

  it("returns the same object when nothing changes, so React can skip re-rendering", () => {
    const t = applyLatest(emptyTimeline(), [msg(1), msg(2)], false).timeline;
    expect(applyIncoming(t, [msg(1)]).timeline).toBe(t);
  });
});
