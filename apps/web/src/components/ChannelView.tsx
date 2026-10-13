import type { Message } from "@parley/shared";
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChannelState, ChatClient, ClientState, PendingMessage } from "../lib/client.ts";
import { Avatar } from "./Avatar.tsx";

const GROUP_WINDOW_MS = 5 * 60_000;
const TYPING_SEND_MS = 1500;

export function ChannelView({
  client,
  state,
  channel,
  title,
  onToggleMembers,
}: {
  client: ChatClient;
  state: ClientState;
  channel: ChannelState;
  title: string;
  onToggleMembers: () => void;
}) {
  const meId = client.me.id;
  const { timeline } = channel;
  const pending = state.pending.filter((p) => p.channelId === channel.id);
  const name = (id: string) => state.members[id]?.username ?? "someone";

  useEffect(() => {
    if (channel.joined) void client.open(channel.id);
  }, [client, channel.id, channel.joined]);

  // Mark as read whenever new messages land while this channel is open and the tab is visible.
  // biome-ignore lint/correctness/useExhaustiveDependencies: timeline.head is the trigger, not an input
  useEffect(() => {
    if (timeline.loaded && document.visibilityState === "visible") client.markRead(channel.id);
  }, [client, channel.id, timeline.loaded, timeline.head]);
  useEffect(() => {
    const onVisible = () => document.visibilityState === "visible" && client.markRead(channel.id);
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [client, channel.id]);

  const typers = Object.entries(state.typing[channel.id] ?? {})
    .filter(([id]) => id !== meId)
    .map(([id]) => name(id));

  const last = timeline.messages[timeline.messages.length - 1];
  const seenBy =
    last && last.senderId === meId
      ? Object.entries(state.reads[channel.id] ?? {})
          .filter(([id, seq]) => id !== meId && seq >= last.seq)
          .map(([id]) => name(id))
      : [];

  if (!channel.joined) {
    return (
      <section className="channel">
        <ChannelHeader title={title} onToggleMembers={onToggleMembers} />
        <div className="empty">
          <p>You're not in {title} yet.</p>
          <button type="button" className="primary" onClick={() => client.join(channel.id)}>
            Join channel
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="channel">
      <ChannelHeader title={title} onToggleMembers={onToggleMembers} />
      <MessageList
        client={client}
        channel={channel}
        pending={pending}
        name={name}
        online={state.online}
        footer={seenBy.length > 0 && <p className="seen-by">Seen by {seenBy.join(", ")}</p>}
      />
      <div className="typing-line" aria-live="polite">
        {typers.length > 0 &&
          `${typers.slice(0, 3).join(", ")}${typers.length > 3 ? " and others" : ""} ${typers.length === 1 ? "is" : "are"} typing…`}
      </div>
      <Composer
        placeholder={`Message ${title}`}
        onSend={(body) => client.sendMessage(channel.id, body)}
        onTyping={() => client.typing(channel.id)}
      />
    </section>
  );
}

function ChannelHeader({ title, onToggleMembers }: { title: string; onToggleMembers: () => void }) {
  return (
    <header className="channel-head">
      <h2 className="truncate">{title}</h2>
      <button
        type="button"
        className="icon"
        onClick={onToggleMembers}
        title="Toggle member list"
        aria-label="Toggle member list"
      >
        👥
      </button>
    </header>
  );
}

function MessageList({
  client,
  channel,
  pending,
  name,
  online,
  footer,
}: {
  client: ChatClient;
  channel: ChannelState;
  pending: PendingMessage[];
  name: (id: string) => string;
  online: ReadonlySet<string>;
  footer: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true); // stay scrolled to the bottom unless the reader scrolled up
  const prevHeight = useRef(0);
  const prevFirst = useRef<number | undefined>(undefined);
  const { timeline } = channel;
  const loadingOlder = useRef(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const first = timeline.messages[0]?.seq;
    if (prevFirst.current !== undefined && first !== undefined && first < prevFirst.current) {
      // Older messages were added above: keep what the reader was looking at in place.
      el.scrollTop += el.scrollHeight - prevHeight.current;
    } else if (pinned.current) {
      el.scrollTop = el.scrollHeight;
    }
    prevFirst.current = first;
    prevHeight.current = el.scrollHeight;
  });

  async function onScroll() {
    const el = ref.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (el.scrollTop < 80 && timeline.hasOlder && !loadingOlder.current) {
      loadingOlder.current = true;
      prevHeight.current = el.scrollHeight;
      await client.loadOlder(channel.id).finally(() => {
        loadingOlder.current = false;
      });
    }
  }

  const rows: React.ReactNode[] = [];
  let prev: Message | undefined;
  for (const m of timeline.messages) {
    const day = new Date(m.createdAt).toDateString();
    if (!prev || new Date(prev.createdAt).toDateString() !== day) {
      rows.push(
        <div key={`day-${m.seq}`} className="day">
          <span>{formatDay(m.createdAt)}</span>
        </div>,
      );
    }
    const grouped =
      prev &&
      prev.senderId === m.senderId &&
      new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < GROUP_WINDOW_MS &&
      new Date(prev.createdAt).toDateString() === day;
    rows.push(
      <article key={m.id} className={`msg ${grouped ? "grouped" : ""}`}>
        {grouped ? (
          <time className="gutter-time">{formatTime(m.createdAt)}</time>
        ) : (
          <Avatar id={m.senderId} name={name(m.senderId)} online={online.has(m.senderId)} />
        )}
        <div className="msg-body">
          {!grouped && (
            <div className="msg-meta">
              <strong>{name(m.senderId)}</strong>
              <time dateTime={m.createdAt}>{formatTime(m.createdAt)}</time>
            </div>
          )}
          <p>{m.body}</p>
        </div>
      </article>,
    );
    prev = m;
  }

  return (
    <div className="messages" ref={ref} onScroll={onScroll}>
      {!timeline.loaded && <p className="empty muted">Loading…</p>}
      {timeline.loaded && timeline.hasOlder && (
        <p className="older muted small">Scroll up for older messages</p>
      )}
      {timeline.loaded && !timeline.hasOlder && (
        <p className="beginning muted small">This is the beginning of the conversation.</p>
      )}
      {rows}
      {footer}
      {pending.map((p) => (
        <article key={p.clientMsgId} className={`msg grouped pending ${p.status}`}>
          <span className="gutter-time">{p.status === "sending" ? "…" : "!"}</span>
          <div className="msg-body">
            <p>{p.body}</p>
            {p.status === "failed" ? (
              <p className="pending-status">
                Not sent: {p.error}{" "}
                <button type="button" className="link small" onClick={() => client.retry(p.clientMsgId)}>
                  Retry
                </button>{" "}
                <button type="button" className="link small" onClick={() => client.discard(p.clientMsgId)}>
                  Discard
                </button>
              </p>
            ) : (
              <p className="pending-status">Sending…</p>
            )}
          </div>
        </article>
      ))}
    </div>
  );
}

function Composer({
  placeholder,
  onSend,
  onTyping,
}: {
  placeholder: string;
  onSend: (body: string) => void;
  onTyping: () => void;
}) {
  const [text, setText] = useState("");
  const lastTyping = useRef(0);
  const ref = useRef<HTMLTextAreaElement>(null);

  // Grow the textarea with its content.
  // biome-ignore lint/correctness/useExhaustiveDependencies: text is the trigger, not an input
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  function submit() {
    const body = text.trim();
    if (!body) return;
    onSend(body);
    setText("");
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <textarea
        ref={ref}
        rows={1}
        value={text}
        maxLength={4000}
        placeholder={placeholder}
        onKeyDown={onKeyDown}
        onChange={(e) => {
          setText(e.target.value);
          const now = Date.now();
          if (e.target.value && now - lastTyping.current > TYPING_SEND_MS) {
            lastTyping.current = now;
            onTyping();
          }
        }}
      />
      <button type="submit" className="primary" disabled={!text.trim()} aria-label="Send">
        Send
      </button>
    </form>
  );
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatDay(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
}
