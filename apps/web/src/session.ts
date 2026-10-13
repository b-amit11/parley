import { Api, type User } from "./lib/api.ts";

export const API_BASE = "/api";
export const WS_URL = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
export const publicApi = new Api(API_BASE);

const KEY = "parley.session";

export type Session = { token: string; user: User };

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function saveSession(session: Session | null): void {
  try {
    if (session) localStorage.setItem(KEY, JSON.stringify(session));
    else localStorage.removeItem(KEY);
  } catch {
    // Private mode or blocked storage: the session just won't survive a reload.
  }
}
