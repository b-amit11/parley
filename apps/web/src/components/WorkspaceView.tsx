import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { Workspace } from "../lib/api.ts";
import { type ChannelState, ChatClient, type ClientState } from "../lib/client.ts";
import { publicApi, type Session, WS_URL } from "../session.ts";
import { ChannelView } from "./ChannelView.tsx";
import { MembersPanel } from "./MembersPanel.tsx";
import { Sidebar } from "./Sidebar.tsx";

export function channelTitle(c: ChannelState, state: ClientState, meId: string): string {
  if (c.kind !== "dm") return `#${c.name}`;
  if (!c.dmUserId || c.dmUserId === meId) return "Notes to self";
  return state.members[c.dmUserId]?.username ?? "Direct message";
}

export function WorkspaceView({
  session,
  workspace,
  onSwitch,
  onSignOut,
}: {
  session: Session;
  workspace: Workspace;
  onSwitch: () => void;
  onSignOut: () => void;
}) {
  const api = useMemo(() => publicApi.withToken(session.token), [session.token]);
  const client = useMemo(
    () =>
      new ChatClient({
        api,
        wsUrl: WS_URL,
        token: session.token,
        me: session.user,
        workspaceId: workspace.id,
      }),
    [api, session, workspace.id],
  );
  const state = useSyncExternalStore(client.subscribe, client.getState);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [showMembers, setShowMembers] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    client.start().catch(() => setError("Couldn't load this workspace"));
    return () => client.stop();
  }, [client]);

  // Open #general (or the first joined channel) once channels arrive.
  const channels = Object.values(state.channels);
  useEffect(() => {
    if (activeId && state.channels[activeId]) return;
    const first = channels.find((c) => c.name === "general") ?? channels.find((c) => c.joined);
    if (first) setActiveId(first.id);
  }, [activeId, channels, state.channels]);

  const active = activeId ? state.channels[activeId] : undefined;

  async function openDm(username: string) {
    const { channel } = await api.openDm(workspace.id, username);
    await client.refreshChannels();
    setActiveId(channel.id);
  }

  return (
    <div className={`app ${showMembers ? "with-members" : ""}`}>
      <Sidebar
        client={client}
        state={state}
        workspace={workspace}
        api={api}
        activeId={activeId}
        onSelect={setActiveId}
        onSwitch={onSwitch}
        onSignOut={onSignOut}
      />
      <main className="main">
        {state.status !== "online" && (
          <div className={`banner ${state.status}`} role="status">
            {state.status === "connecting"
              ? "Connecting…"
              : "Connection lost. Reconnecting… Anything you send will go out when you're back."}
          </div>
        )}
        {error && <div className="banner offline">{error}</div>}
        {active ? (
          <ChannelView
            key={active.id}
            client={client}
            state={state}
            channel={active}
            title={channelTitle(active, state, session.user.id)}
            onToggleMembers={() => setShowMembers((v) => !v)}
          />
        ) : (
          <div className="empty muted">Pick a channel</div>
        )}
      </main>
      {showMembers && (
        <MembersPanel
          state={state}
          workspace={workspace}
          api={api}
          client={client}
          meId={session.user.id}
          onOpenDm={openDm}
        />
      )}
    </div>
  );
}
