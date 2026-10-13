import { useEffect, useState } from "react";
import { AuthScreen } from "./components/AuthScreen.tsx";
import { WorkspacePicker } from "./components/WorkspacePicker.tsx";
import { WorkspaceView } from "./components/WorkspaceView.tsx";
import { ApiError, type Workspace } from "./lib/api.ts";
import { loadSession, publicApi, type Session, saveSession } from "./session.ts";

export function App() {
  const [session, setSession] = useState<Session | null>(loadSession);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);

  // Check a remembered session is still valid.
  useEffect(() => {
    if (!session) return;
    publicApi
      .withToken(session.token)
      .me()
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) signOut();
      });
  }, [session]);

  function signIn(next: Session) {
    saveSession(next);
    setSession(next);
  }

  function signOut() {
    if (session)
      void publicApi
        .withToken(session.token)
        .logout()
        .catch(() => {});
    saveSession(null);
    setSession(null);
    setWorkspace(null);
  }

  if (!session) return <AuthScreen onSignedIn={signIn} />;
  if (!workspace) return <WorkspacePicker session={session} onPick={setWorkspace} onSignOut={signOut} />;
  return (
    <WorkspaceView
      key={workspace.id}
      session={session}
      workspace={workspace}
      onSwitch={() => setWorkspace(null)}
      onSignOut={signOut}
    />
  );
}
