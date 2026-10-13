import { type FormEvent, useEffect, useMemo, useState } from "react";
import { ApiError, type Workspace } from "../lib/api.ts";
import { publicApi, type Session } from "../session.ts";

export function WorkspacePicker({
  session,
  onPick,
  onSignOut,
}: {
  session: Session;
  onPick: (w: Workspace) => void;
  onSignOut: () => void;
}) {
  const api = useMemo(() => publicApi.withToken(session.token), [session.token]);
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.workspaces().then(
      (r) => setWorkspaces(r.workspaces),
      () => setError("Couldn't load your workspaces"),
    );
  }, [api]);

  async function create(e: FormEvent) {
    e.preventDefault();
    try {
      const { workspace } = await api.createWorkspace(name.trim());
      onPick(workspace);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't create the workspace");
    }
  }

  return (
    <main className="center-screen">
      <div className="card picker">
        <div className="picker-head">
          <h1>Your workspaces</h1>
          <button type="button" className="link" onClick={onSignOut}>
            Sign out {session.user.username}
          </button>
        </div>
        {workspaces === null && !error && <p className="muted">Loading…</p>}
        {workspaces?.length === 0 && (
          <p className="muted">
            You're not in any workspaces yet. Create one, or ask an owner to invite you.
          </p>
        )}
        <ul className="workspace-list">
          {workspaces?.map((w) => (
            <li key={w.id}>
              <button type="button" onClick={() => onPick(w)}>
                <span className="avatar square" aria-hidden>
                  {w.name[0]?.toUpperCase()}
                </span>
                <span className="grow">{w.name}</span>
                <span className="muted small">{w.role}</span>
              </button>
            </li>
          ))}
        </ul>
        <form className="inline-form" onSubmit={create}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="New workspace name"
            required
          />
          <button type="submit" className="primary">
            Create
          </button>
        </form>
        {error && <p className="form-error">{error}</p>}
      </div>
    </main>
  );
}
