import { type FormEvent, useState } from "react";
import { ApiError } from "../lib/api.ts";
import { publicApi, type Session } from "../session.ts";

// Set at build time for hosted demos (deploy/single.Dockerfile), e.g. "alice:parley-demo".
const DEMO_LOGIN: string | undefined = import.meta.env.VITE_DEMO_LOGIN;
const [demoUser, demoPassword] = DEMO_LOGIN?.split(":") ?? [];

export function AuthScreen({ onSignedIn }: { onSignedIn: (s: Session) => void }) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const fn = mode === "login" ? publicApi.login : publicApi.signup;
      const { user, token } = await fn(username.trim().toLowerCase(), password);
      onSignedIn({ user, token });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't reach the server");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="center-screen">
      <form className="card auth" onSubmit={submit}>
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            ◆
          </span>{" "}
          parley
        </div>
        <h1>{mode === "login" ? "Sign in" : "Create an account"}</h1>
        <label>
          Username
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            placeholder="lowercase, 3–32 characters"
            required
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            placeholder="at least 8 characters"
            required
          />
        </label>
        {mode === "login" && demoUser && demoPassword && (
          <div className="demo-hint">
            <p>
              Demo account: <code>{demoUser}</code> / <code>{demoPassword}</code>. Sign in as <code>bob</code> in a
              second window to watch messages arrive live.
            </p>
            <button
              type="button"
              className="link"
              onClick={() => {
                setUsername(demoUser);
                setPassword(demoPassword);
              }}
            >
              Fill in the demo account
            </button>
          </div>
        )}
        {error && <p className="form-error">{error}</p>}
        <button type="submit" className="primary" disabled={busy}>
          {busy ? "…" : mode === "login" ? "Sign in" : "Create account"}
        </button>
        <button type="button" className="link" onClick={() => setMode(mode === "login" ? "signup" : "login")}>
          {mode === "login" ? "New here? Create an account" : "Already have an account? Sign in"}
        </button>
      </form>
    </main>
  );
}
