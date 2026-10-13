import { type FormEvent, useState } from "react";
import { type Api, ApiError, type Workspace } from "../lib/api.ts";
import type { ChatClient, ClientState } from "../lib/client.ts";
import { Avatar } from "./Avatar.tsx";

export function MembersPanel({
  state,
  workspace,
  api,
  client,
  meId,
  onOpenDm,
}: {
  state: ClientState;
  workspace: Workspace;
  api: Api;
  client: ChatClient;
  meId: string;
  onOpenDm: (username: string) => Promise<void>;
}) {
  const members = Object.values(state.members).sort(
    (a, b) =>
      Number(state.online.has(b.id)) - Number(state.online.has(a.id)) || a.username.localeCompare(b.username),
  );
  const onlineCount = members.filter((m) => state.online.has(m.id)).length;

  return (
    <aside className="members">
      <h3>
        Members <span className="muted small">{onlineCount} online</span>
      </h3>
      <ul>
        {members.map((m) => (
          <li key={m.id}>
            <button
              type="button"
              className="nav-item"
              onClick={() => void onOpenDm(m.username)}
              title={`Message ${m.username}`}
            >
              <Avatar id={m.id} name={m.username} online={state.online.has(m.id)} />
              <span className="grow truncate">
                {m.username}
                {m.id === meId && <span className="muted"> (you)</span>}
              </span>
              {m.role === "owner" && <span className="small muted">owner</span>}
            </button>
          </li>
        ))}
      </ul>
      {workspace.role === "owner" && (
        <InviteForm api={api} workspaceId={workspace.id} onInvited={() => client.refreshMembers()} />
      )}
    </aside>
  );
}

function InviteForm({
  api,
  workspaceId,
  onInvited,
}: {
  api: Api;
  workspaceId: string;
  onInvited: () => Promise<void>;
}) {
  const [username, setUsername] = useState("");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      const { added } = await api.invite(workspaceId, username.trim().toLowerCase());
      setNote({ ok: true, text: added ? `Added ${username}` : `${username} is already a member` });
      setUsername("");
      await onInvited();
    } catch (err) {
      setNote({ ok: false, text: err instanceof ApiError ? err.message : "Couldn't invite" });
    }
  }

  return (
    <form className="invite" onSubmit={submit}>
      <label className="small muted" htmlFor="invite">
        Invite by username
      </label>
      <div className="inline-form">
        <input
          id="invite"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="username"
          required
        />
        <button type="submit" className="primary small">
          Invite
        </button>
      </div>
      {note && <p className={note.ok ? "small muted" : "form-error"}>{note.text}</p>}
    </form>
  );
}
