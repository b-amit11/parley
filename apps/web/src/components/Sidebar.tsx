import { type FormEvent, useEffect, useRef, useState } from "react";
import { type Api, ApiError, type Workspace } from "../lib/api.ts";
import type { ChannelState, ChatClient, ClientState } from "../lib/client.ts";
import { channelTitle } from "./WorkspaceView.tsx";

export function Sidebar({
  client,
  state,
  workspace,
  api,
  activeId,
  onSelect,
  onSwitch,
  onSignOut,
}: {
  client: ChatClient;
  state: ClientState;
  workspace: Workspace;
  api: Api;
  activeId: string | null;
  onSelect: (id: string) => void;
  onSwitch: () => void;
  onSignOut: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const all = Object.values(state.channels);
  const joined = all.filter((c) => c.joined && c.kind !== "dm");
  const browsable = all.filter((c) => !c.joined && c.kind === "public");
  const dms = all.filter((c) => c.kind === "dm");

  const item = (c: ChannelState) => {
    const unread = c.id === activeId ? 0 : c.unread;
    const other = c.kind === "dm" ? c.dmUserId : null;
    return (
      <li key={c.id}>
        <button
          type="button"
          className={`nav-item ${c.id === activeId ? "active" : ""} ${unread ? "unread" : ""}`}
          onClick={() => onSelect(c.id)}
        >
          {c.kind === "dm" ? (
            <span className={`presence ${other && state.online.has(other) ? "on" : ""}`} aria-hidden />
          ) : (
            <span className="hash" aria-hidden>
              {c.kind === "private" ? "🔒" : "#"}
            </span>
          )}
          <span className="grow truncate">{channelTitle(c, state, client.me.id).replace(/^#/, "")}</span>
          {unread > 0 && <span className="badge">{unread > 99 ? "99+" : unread}</span>}
        </button>
      </li>
    );
  };

  return (
    <nav className="sidebar">
      <header className="sidebar-head">
        <button type="button" className="workspace-name" onClick={onSwitch} title="Switch workspace">
          {workspace.name} <span aria-hidden>⌄</span>
        </button>
        <span className={`status-pill ${state.status}`}>{state.status}</span>
      </header>

      <section>
        <div className="section-head">
          <span>Channels</span>
          <button
            type="button"
            className="icon"
            onClick={() => setCreating((v) => !v)}
            title="New channel"
            aria-label="New channel"
          >
            +
          </button>
        </div>
        {creating && (
          <NewChannelForm
            api={api}
            workspaceId={workspace.id}
            onCreated={async (id) => {
              setCreating(false);
              await client.refreshChannels();
              onSelect(id);
            }}
          />
        )}
        <ul>{joined.map(item)}</ul>
        {browsable.length > 0 && (
          <details className="browse">
            <summary>More channels ({browsable.length})</summary>
            <ul>
              {browsable.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    className="nav-item"
                    onClick={async () => {
                      await client.join(c.id);
                      onSelect(c.id);
                    }}
                  >
                    <span className="hash">#</span>
                    <span className="grow truncate">{c.name}</span>
                    <span className="small muted">Join</span>
                  </button>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <section>
        <div className="section-head">
          <span>Direct messages</span>
        </div>
        {dms.length === 0 && <p className="hint">Click someone in the member list to message them.</p>}
        <ul>{dms.map(item)}</ul>
      </section>

      <footer className="sidebar-foot">
        <span className="truncate">{client.me.username}</span>
        <button
          type="button"
          className="link small"
          onClick={() => client.dropConnection()}
          title="Drops the WebSocket to show reconnect and catch-up"
        >
          Simulate drop
        </button>
        <button type="button" className="link small" onClick={onSignOut}>
          Sign out
        </button>
      </footer>
    </nav>
  );
}

function NewChannelForm({
  api,
  workspaceId,
  onCreated,
}: {
  api: Api;
  workspaceId: string;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [isPrivate, setPrivate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      const { channel } = await api.createChannel(
        workspaceId,
        name.trim().toLowerCase(),
        isPrivate ? "private" : "public",
      );
      onCreated(channel.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't create the channel");
    }
  }

  return (
    <form className="new-channel" onSubmit={submit}>
      <input
        ref={input}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="channel-name"
        required
      />
      <label className="check">
        <input type="checkbox" checked={isPrivate} onChange={(e) => setPrivate(e.target.checked)} /> Private
      </label>
      <button type="submit" className="primary small">
        Create
      </button>
      {error && <p className="form-error">{error}</p>}
    </form>
  );
}
